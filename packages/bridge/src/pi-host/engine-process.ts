/**
 * Pi Host — engine process manager.
 *
 * Decision (docs/ENGINE-INTEGRATION.md): the pi engine runs as a child
 * process in official `--mode rpc` (JSONL over stdio). This module owns the
 * process lifecycle and the JSONL framing (request/response correlation +
 * one-way events), so the bridge/UI layer never depends on a specific pi
 * version. Engine hot-swap = restart the child with a new engines/<ver> path.
 *
 * Wire frames follow pi docs/rpc.md: commands to stdin, responses + events on
 * stdout, strict LF framing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

/** A JSON-RPC-ish request to the engine (pi rpc command). */
export interface EngineRequest {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface EngineResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  [key: string]: unknown;
}

/** One-way engine event (e.g. message_update, extension_ui_request). */
export interface EngineEvent {
  type: string;
  [key: string]: unknown;
}

export interface EngineProcessOptions {
  /** Absolute path to the pi CLI entry (engines/<ver> bundle). */
  piEntry: string;
  cwd: string;
  env?: Record<string, string>;
  /** Extra argv, e.g. --no-session. */
  args?: string[];
}

export class EngineProcess {
  private proc?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private readonly pending = new Map<
    string,
    (response: EngineResponse) => void
  >();

  /** Registered one-way event handlers. */
  onEvent?: (event: EngineEvent) => void;
  /** Registered handler for extension UI requests (approvals/dialogs). */
  onUiRequest?: (request: EngineEvent, respond: (value: unknown) => void) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;

  get running(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null;
  }

  async start(opts: EngineProcessOptions): Promise<void> {
    if (this.running) throw new Error("engine already running");

    const env = {
      ...process.env,
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      ...opts.env,
    };
    const isJsEntry =
      opts.piEntry.endsWith(".js") || opts.piEntry.endsWith(".mjs") || opts.piEntry.endsWith(".cjs");
    if (process.env.PI_DEBUG_SPAWN === "1") {
      console.log("SPAWN", JSON.stringify({ entry: opts.piEntry, cwd: opts.cwd, env: { ...env, PI_DEBUG_SPAWN: undefined } }));
    }
    const child = isJsEntry
      ? spawn(process.execPath, [opts.piEntry, "--mode", "rpc", ...(opts.args ?? [])], {
          cwd: opts.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(opts.piEntry, ["--mode", "rpc", ...(opts.args ?? [])], {
          cwd: opts.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
    this.proc = child;
    this.lines = createInterface({ input: child.stdout });

    child.stdin.on("error", () => { /* stdin EPIPE after engine exit */ });
    child.stderr.on("data", (d: Buffer) => {
      // Engine diagnostics; surface for logs, never parse as protocol.
      process.stderr.write(`[pi-engine] ${String(d)}`);
    });

    this.lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      let frame: EngineResponse | EngineEvent;
      try {
        frame = JSON.parse(line) as EngineResponse | EngineEvent;
      } catch {
        return; // ignore non-JSON noise
      }
      this.dispatch(frame);
    });

    child.on("error", (err) => {
      // spawn failure (missing engine bundle etc.)
      this.onExit?.(-1, null);
      void err;
    });
    child.on("exit", (code, signal) => {
      this.onExit?.(code, signal);
      this.lines?.close();
      this.pending.forEach((resolve) =>
        resolve({ type: "response", command: "?engine_exited", success: false }),
      );
      this.pending.clear();
      this.proc = undefined;
    });

    await once(child, "spawn");
  }

  private dispatch(frame: EngineResponse | EngineEvent): void {
    if (frame.type === "response") {
      const resp = frame as EngineResponse;
      const id = resp.id;
      if (id !== undefined) {
        const resolve = this.pending.get(String(id));
        if (resolve) {
          this.pending.delete(String(id));
          resolve(resp);
        }
      }
      return;
    }
    const event = frame as EngineEvent;
    if (event.type === "extension_ui_request") {
      const respond = (value: unknown): void => {
        const id = String(event.id ?? randomUUID());
        this.send({
          type: "extension_ui_response",
          id,
          ...(value as Record<string, unknown>),
        } as unknown as EngineRequest);
      };
      this.onUiRequest?.(event, respond);
      return;
    }
    this.onEvent?.(event);
  }

  /** Send a request; resolves with the correlated response (10 min cap). */
  request(req: EngineRequest, timeoutMs = 600_000): Promise<EngineResponse> {
    if (!this.running || !this.proc) {
      return Promise.resolve({
        type: "response",
        command: req.type,
        success: false,
        error: "engine_not_running",
      });
    }
    const id = req.id ?? randomUUID();
    const full = { ...req, id };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          type: "response",
          command: req.type,
          id,
          success: false,
          error: "engine_request_timeout",
        });
      }, timeoutMs);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.proc!.stdin.write(`${JSON.stringify(full)}\n`);
    });
  }

  /** Fire-and-forget write (e.g. extension_ui_response, clear_queue). */
  send(frame: EngineRequest): void {
    if (this.running && this.proc) {
      this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    await once(this.proc, "exit").catch(() => undefined);
  }
}
