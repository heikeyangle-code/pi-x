/**
 * PiAdapter — route the CC Pocket chat-turn messages to a pi engine while
 * keeping every other Bridge capability (files, workspace, git, upload,
 * download) on the existing BridgeWebSocketServer path.
 *
 * Rationale (docs/M2-WIRING.md, docs/ENGINE-INTEGRATION.md §6):
 *   - We do NOT replace the whole server with pi-host. We keep the existing
 *     BridgeWebSocketServer as the single transport and make pi a pluggable
 *     engine for the *agent* messages only. Files/workspace/git/upload are
 *     engine-agnostic and stay exactly where they are.
 *   - This adapter is a thin translator: inbound CC ops -> PiGateway control
 *     ops (via cc-adapter.inboundToActions), outbound pi events -> CC Pocket
 *     ServerMessages (via cc-adapter.piFrameToServerMessages).
 *   - Depends on a structural PiGatewayLike so it is unit-testable without
 *     spawning a real pi binary.
 *
 * Only present when PI_HOST=1; otherwise BridgeWebSocketServer behaves exactly
 * as before (adapter is null).
 */

import type { WebSocket } from "ws";
import type {
  ClientControlMessage,
  PiFrameEnvelope,
} from "./pi-gateway.js";
import type { ClientMessage, ServerMessage } from "../parser.js";
import {
  inboundToActions,
  piFrameToServerMessages,
} from "./cc-adapter.js";
import { PiSessionRegistry } from "./pi-sessions.js";

/**
 * Minimal gateway surface the adapter needs. Structural so tests can inject a
 * fake (no real `pi --mode rpc` process).
 */
export interface PiGatewayLike {
  /** Wire sink set by the adapter; engine events arrive through it. */
  send?: (envelope: PiFrameEnvelope) => void;
  handleControl(msg: ClientControlMessage): Promise<unknown>;
  respondUi(requestId: string, value: unknown): boolean;
  stopAll(): Promise<void>;
  /** pi home root (~); used for session scans (~/.pi/agent/sessions). */
  readonly piHome: string;
}

export interface PiAdapterOptions {
  gateway: PiGatewayLike;
}

/**
 * CC Pocket chat-turn messages routed to the pi engine in PI_HOST=1 mode.
 * Everything else (list_directory/get_diff/read/write file/upload/download/
 * git/workspace/...) keeps flowing to the existing BridgeWebSocketServer code.
 */
const PI_CHAT_OPS = new Set<string>([
  "start",
  "input",
  "approve",
  "reject",
  "answer",
  "stop_session",
]);

export class PiAdapter {
  /**
   * Message sink installed by BridgeWebSocketServer on construction so outbound
   * pi events reach the right socket through the server's own send()/protocol
   * filtering.
   */
  deliver?: (ws: WebSocket, message: unknown) => void;

  /** Active pi sessions (CC sessionId -> project); fed by `start` + events. */
  readonly registry = new PiSessionRegistry();

  /**
   * Status transition callback (projectId, status). The bridge uses it to
   * keep its session list in sync (broadcast session_list on idle->running).
   */
  onStatus?: (projectId: string, status: string) => void;

  private readonly gatewayImpl: PiGatewayLike;
  /** projectId -> sockets subscribed to that project's engine events. */
  private readonly subscribed = new Map<string, Set<WebSocket>>();
  private readonly wsProject = new WeakMap<WebSocket, string>();

  constructor(opts: PiAdapterOptions) {
    this.gatewayImpl = opts.gateway;
    // PiGateway is transport-agnostic: on construction it installs its event
    // sink so we can forward engine frames to subscribed sockets.
    this.gatewayImpl.send = (envelope) => this.dispatch(envelope);
  }

  /** Gateway handle for the session surface (history/list scans). */
  get gateway(): PiGatewayLike {
    return this.gatewayImpl;
  }

  /** Whether this CC client message should be handled by the pi engine. */
  accepts(msg: ClientMessage): boolean {
    return PI_CHAT_OPS.has(msg.type);
  }

  /**
   * Warm the engine for a project and fold its state (model/name) into the
   * session registry. Resolves with the engine get_state response (or
   * undefined when the engine could not be reached). Used by `start` and the
   * bridge's pi resume path.
   */
  async warm(projectId: string): Promise<unknown> {
    const state = await this.gatewayImpl
      .handleControl({ type: "control", op: "get_state", projectId })
      .catch(() => undefined);
    this.applyStateToRegistry(projectId, state);
    return state;
  }

  /** Pin a socket to a project so engine events are delivered to it. */
  bind(ws: WebSocket, projectId: string): void {
    if (!projectId) return;
    this.wsProject.set(ws, projectId);
    let set = this.subscribed.get(projectId);
    if (!set) {
      set = new Set<WebSocket>();
      this.subscribed.set(projectId, set);
    }
    set.add(ws);
    ws.once("close", () => {
      set.delete(ws);
      if (set.size === 0) this.subscribed.delete(projectId);
    });
  }

  /** Handle a CC chat-turn message; true when the adapter consumed it. */
  async handle(ws: WebSocket, msg: ClientMessage): Promise<boolean> {
    if (!this.accepts(msg)) return false;

    const projectId = this.projectFor(ws, msg);

    // `start` establishes the project binding and warms the engine so that
    // spawn-time configuration (runtime route, engine args, SYSTEM.md ...) is
    // applied immediately. The socket then idles until the first `input`.
    if (msg.type === "start") {
      this.bind(ws, projectId);
      const raw = msg as Record<string, unknown>;
      // The app opens a session without a bridge-side id on new sessions; the
      // bridge generates one and returns it in `session_created` so the app can
      // correlate get_history/input against the same id afterwards.
      let sessionId =
        typeof raw.sessionId === "string" ? String(raw.sessionId) : "";
      if (sessionId === "") {
        sessionId = generateSessionId();
      }
      this.registry.register(sessionId, projectId, "idle");
      this.registry.touch(sessionId);
      await this.warm(projectId);
      const entry = this.registry.get(sessionId);
      this.deliver?.(ws, {
        type: "system",
        subtype: "session_created",
        sessionId,
        provider: "pi",
        projectPath: projectId,
        status: "idle",
        ...(entry?.model ? { model: entry.model } : {}),
      });
      this.deliver?.(ws, { type: "status", status: "idle", sessionId });
      return true;
    }

    if (!projectId) return true; // no project context yet; drop silently.

    for (const action of inboundToActions(msg as never)) {
      if (action.kind === "control" && action.op) {
        const result = await this.gateway.handleControl({
          type: "control",
          op: action.op,
          projectId,
          payload: action.payload,
        });
        // Failed engine responses (e.g. prompt with no provider configured)
        // carry success:false + error and produce no streamed events. Surface
        // them as a CC `error` message, otherwise the app waits forever with
        // no visible feedback (the engine stays alive and idle).
        if (isFailedEngineResponse(result)) {
          this.deliver?.(ws, {
            type: "error",
            message: result.error,
            sessionId:
              typeof (msg as Record<string, unknown>)["sessionId"] === "string"
                ? String((msg as Record<string, unknown>)["sessionId"])
                : undefined,
            projectId,
          });
        }
        // Record the engine model (from get_state/cycle_model etc.) into the
        // session registry so session_list shows the active model.
        this.applyStateToRegistry(projectId, result);
      } else if (action.kind === "ui_response") {
        this.gateway.respondUi(String(action.uiRequestId ?? ""), action.value);
      }
    }
    return true;
  }

  /**
   * Resolve the target project id from the message or the socket binding.
   *
   * The CC Pocket client sends the workspace path as `projectPath` on `start`
   * (parser.ts); the pi gateway treats a project id as its cwd, so the path
   * and the id are the same string. We therefore accept both `projectId` and
   * `projectPath`, fall back to the session registry (app messages carry
   * `sessionId` after `start`), then to the binding established by `start`.
   */
  private projectFor(ws: WebSocket, msg: ClientMessage): string {
    const raw = msg as Record<string, unknown>;
    const id = typeof raw.projectId === "string" ? raw.projectId : "";
    if (id !== "") return id;
    const path = typeof raw.projectPath === "string" ? raw.projectPath : "";
    if (path !== "") return path;
    const sessionId =
      typeof raw.sessionId === "string" ? String(raw.sessionId) : "";
    if (sessionId !== "") {
      const entry = this.registry.get(sessionId);
      if (entry !== undefined) return entry.projectId;
    }
    return this.wsProject.get(ws) ?? "";
  }

  /** Extract model/sessionName from a get_state/cycle_model engine response. */
  private applyStateToRegistry(projectId: string, result: unknown): void {
    if (result === null || typeof result !== "object") return;
    const r = result as Record<string, unknown>;
    if (r.success === false) return;
    const stateData =
      r["data"] !== null && typeof r["data"] === "object"
        ? (r["data"] as Record<string, unknown>)
        : undefined;
    if (stateData === undefined) return;
    const model = stateData["model"] as Record<string, unknown> | undefined;
    if (model !== null && typeof model === "object") {
      const modelId = String(model["id"] ?? model["model"] ?? "");
      if (modelId !== "") this.registry.setModel(projectId, modelId);
    }
    const sessionName =
      typeof stateData["sessionName"] === "string"
        ? String(stateData["sessionName"])
        : undefined;
    if (sessionName !== undefined && sessionName !== "") {
      const entry = this.registry.getByProject(projectId);
      if (entry !== undefined) {
        this.registry.rename(entry.sessionId, sessionName);
      }
    }
  }

  /** Forward an engine frame envelope to sockets subscribed to its project. */
  private dispatch(envelope: PiFrameEnvelope): void {
    const frame = (envelope.frame as Record<string, unknown>) ?? {};
    const projectId = String(frame["projectId"] ?? "");
    const sockets = projectId ? this.subscribed.get(projectId) : undefined;
    if (!sockets || sockets.size === 0) return;
    const messages = piFrameToServerMessages(frame as never);
    if (messages.length === 0) return;
    for (const ws of [...sockets]) {
      for (const message of messages) {
        if (message.type === "status" && typeof message.status === "string") {
          this.registry.setStatus(projectId, message.status as "idle" | "running");
          this.onStatus?.(projectId, message.status as string);
        }
        this.deliver?.(ws, message);
      }
    }
  }

  stopAll(): Promise<void> {
    return this.gateway.stopAll();
  }
}

/** Narrow a CompatMessage to a ServerMessage for the server's send(). */
export function toServerMessage(message: unknown): ServerMessage | Record<string, unknown> {
  return message as unknown as ServerMessage;
}

/**
 * Narrow a handleControl() result to a failed engine response
 * ({success:false, error}). Engine failures (e.g. prompt with no provider
 * configured) resolve rather than reject, so without this guard the app would
 * get no feedback at all (the engine stays alive and idle).
 */
export function isFailedEngineResponse(
  result: unknown,
): result is { success: false; error: string } {
  if (result === null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return r.success === false && typeof r.error === "string" && r.error !== "";
}

let sessionIdCounter = 0;
/** Bridge-side session id for a pi session opened without an app-provided id. */
export function generateSessionId(): string {
  sessionIdCounter += 1;
  return `pi-${Date.now().toString(36)}-${sessionIdCounter.toString(36)}`;
}