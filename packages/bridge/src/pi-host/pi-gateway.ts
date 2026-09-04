/**
 * Pi Gateway — thin passthrough between the app client and pi engines.
 *
 * End-state wire design (docs/ENGINE-INTEGRATION.md §6): the app consumes the
 * pi event model 1:1. This gateway:
 *   - wraps every engine frame in an envelope {engineVersion, protocolVersion}
 *     so clients can do forward-compatible version handling;
 *   - forwards client control messages to the right project engine (prompt,
 *     steer, abort, get_state, ...) with request/response correlation;
 *   - keeps filesystem-ish ops (diff, directory listing) out of scope (they
 *     stay on the bridge FS layer).
 *
 * Transport-agnostic: `send` is provided by the caller (websocket adapter).
 */

import { EnginePool } from "./engine-pool.js";
import type { EngineEvent } from "./engine-process.js";
import * as rpc from "./pi-rpc.js";

export const PI_WIRE_PROTOCOL_VERSION = 1;

export interface PiFrameEnvelope {
  kind: "pi";
  engineVersion: string;
  protocolVersion: number;
  /** Engine version of the event/frame schema. */
  frame: unknown;
}

export interface ClientControlMessage {
  id?: string;
  type: "control";
  op: string;
  /** Project (workspace) the message targets. */
  projectId: string;
  payload?: Record<string, unknown>;
}

export interface PiGatewayOptions {
  piEntry: string;
  engineVersion: string;
  protocolVersion?: number;
  maxIdleMs?: number;
  env?: Record<string, string>;
  /** Resolve the cwd (filesystem path) for a project id. */
  resolveCwd: (projectId: string) => string;
}

export class PiGateway {
  private readonly pool: EnginePool;
  private readonly opts: PiGatewayOptions;
  private readonly protocolVersion: number;

  constructor(opts: PiGatewayOptions) {
    this.opts = opts;
    this.protocolVersion = opts.protocolVersion ?? PI_WIRE_PROTOCOL_VERSION;
    this.pool = new EnginePool({
      piEntry: opts.piEntry,
      maxIdleMs: opts.maxIdleMs,
      env: opts.env,
      onEvent: (projectId, event) => this.emit(projectId, event),
      onUiRequest: (projectId, request, respond) =>
        this.emit(projectId, {
          type: "extension_ui_request",
          projectId,
          request,
          respond,
        }),
      onExit: (projectId, code, signal) =>
        this.emit(projectId, { type: "engine_exit", projectId, code, signal }),
    });
  }

  /** Wire sink installed by the transport adapter. */
  send?: (envelope: PiFrameEnvelope) => void;

  private emit(projectId: string, frame: unknown): void {
    this.send?.({
      kind: "pi",
      engineVersion: this.opts.engineVersion,
      protocolVersion: this.protocolVersion,
      frame: { projectId, ...(frame as Record<string, unknown>) },
    });
  }

  /** Handle one client control message; resolves with the engine response. */
  async handleControl(msg: ClientControlMessage): Promise<unknown> {
    const cwd = this.opts.resolveCwd(msg.projectId);
    const engine = await this.pool.getOrStart(msg.projectId, cwd);
    const payload = msg.payload ?? {};

    switch (msg.op) {
      case "prompt":
        return rpc.prompt(engine, {
          message: String(payload.message ?? ""),
          streamingBehavior: payload.streamingBehavior as
            | "steer"
            | "followUp"
            | undefined,
        });
      case "steer":
        return rpc.steer(engine, String(payload.message ?? ""));
      case "follow_up":
        return rpc.followUp(engine, String(payload.message ?? ""));
      case "abort":
        return rpc.abort(engine);
      case "get_state":
        return rpc.getState(engine);
      case "get_commands":
        return rpc.getCommands(engine);
      case "set_model":
        return rpc.setModel(
          engine,
          String(payload.provider ?? ""),
          String(payload.modelId ?? ""),
        );
      case "get_available_models":
        return rpc.getAvailableModels(engine);
      case "set_thinking_level":
        return rpc.setThinkingLevel(engine, payload.level as string | number);
      case "get_tree":
        return rpc.getSessionTree(engine);
      case "fork":
        return rpc.forkSession(engine, payload);
      case "switch_session":
        return rpc.switchSession(engine, String(payload.sessionPath ?? ""));
      case "get_session_stats":
        return rpc.getSessionStats(engine);
      case "compact":
        return rpc.compact(
          engine,
          payload.customInstructions === undefined
            ? undefined
            : String(payload.customInstructions),
        );
      case "bash": {
        const response = await rpc.runBash(
          engine,
          String(payload.command ?? ""),
          msg.id,
        );
        return response;
      }
      case "abort_bash":
        return rpc.abortBash(engine);
      case "stop":
        await this.pool.stop(msg.projectId);
        return { stopped: true };
      default:
        return {
          type: "response",
          command: msg.op,
          success: false,
          error: `unsupported_op:${msg.op}`,
        };
    }
  }

  stopAll(): Promise<void> {
    return this.pool.stopAll();
  }
}
