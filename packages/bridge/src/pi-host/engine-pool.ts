/**
 * Engine pool — one pi engine process per project.
 *
 * Mirrors pi's own model: sessions & resources are organized per working
 * directory (docs/sessions.md). A project switch therefore means a different
 * engine process (its own session tree, AGENTS.md walk, project .pi
 * resources, trust state); user-global resources load in every process.
 *
 * Idle processes are reaped after `maxIdleMs` (phone resources).
 */

import { EngineProcess, type EngineEvent, type EngineProcessOptions } from "./engine-process.js";

export interface EnginePoolOptions {
  /** Absolute path to the pi CLI entry of the active engine bundle. */
  piEntry: string;
  onEvent?: (projectId: string, event: EngineEvent) => void;
  /** Called with (respond, value) semantics — see EngineProcess.onUiRequest. */
  onUiRequest?: (
    projectId: string,
    request: EngineEvent,
    respond: (value: unknown) => void,
  ) => void;
  onExit?: (projectId: string, code: number | null, signal: NodeJS.Signals | null) => void;
  /** Default 10 minutes of inactivity before an engine process is stopped. */
  maxIdleMs?: number;
  env?: Record<string, string>;
}

interface Slot {
  engine: EngineProcess;
  lastActive: number;
  timer?: NodeJS.Timeout;
}

// Default idle-reap window. Must NOT be overwritten by an explicit `undefined`
// from callers (e.g. PiGateway passes `maxIdleMs: opts.maxIdleMs`), otherwise
// `setTimeout(fn, undefined)` fires ~immediately and reaps a freshly-spawned
// engine right after the boot guard (see docs/STATUS known-issue #1).
export const DEFAULT_ENGINE_MAX_IDLE_MS = 10 * 60_000;

export class EnginePool {
  private readonly slots = new Map<string, Slot>();
  private readonly opts: { maxIdleMs: number } & EnginePoolOptions;

  constructor(opts: EnginePoolOptions) {
    this.opts = { ...opts, maxIdleMs: opts.maxIdleMs ?? DEFAULT_ENGINE_MAX_IDLE_MS };
  }

  get projectIds(): string[] {
    return [...this.slots.keys()];
  }

  isRunning(projectId: string): boolean {
    return this.slots.get(projectId)?.engine.running === true;
  }

  async getOrStart(projectId: string, cwd: string, attempt = 1): Promise<EngineProcess> {
    const existing = this.slots.get(projectId);
    if (existing !== undefined && existing.engine.running) {
      this.touch(projectId, existing);
      return existing.engine;
    }
    this.stop(projectId).catch(() => undefined);

    const engine = new EngineProcess();
    const slot: Slot = { engine, lastActive: Date.now() };
    this.slots.set(projectId, slot);

    engine.onEvent = (event) => this.opts.onEvent?.(projectId, event);
    engine.onUiRequest = (request, respond) =>
      this.opts.onUiRequest?.(projectId, request, respond);
    engine.onExit = (code, signal) => {
      this.slots.delete(projectId);
      this.opts.onExit?.(projectId, code, signal);
    };

    const options: EngineProcessOptions = {
      piEntry: this.opts.piEntry,
      cwd,
      env: this.opts.env,
    };
    await engine.start(options);
    // Boot guard: if the engine dies within the grace window (platform spawn
    // races), retry a bounded number of times before exposing it to callers.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!engine.running && attempt < 3) {
      await engine.stop().catch(() => undefined);
      this.slots.delete(projectId);
      return this.getOrStart(projectId, cwd, attempt + 1);
    }
    this.touch(projectId, slot);
    return engine;
  }

  private touch(projectId: string, slot: Slot): void {
    slot.lastActive = Date.now();
    if (slot.timer !== undefined) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    slot.timer = setTimeout(() => {
      void this.stop(projectId);
    }, this.opts.maxIdleMs);
    slot.timer.unref?.();
  }

  async stop(projectId: string): Promise<void> {
    const slot = this.slots.get(projectId);
    if (slot === undefined) return;
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    this.slots.delete(projectId);
    if (slot.engine.running) {
      await slot.engine.stop();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((id) => this.stop(id)));
  }
}
