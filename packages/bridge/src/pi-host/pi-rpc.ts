/**
 * Typed RPC command wrappers for the pi engine (docs/rpc.md, pi 0.85.x).
 *
 * These mirror the official JSONL command surface so the bridge/UI layer can
 * drive the engine without hand-writing frames. Payloads verified against
 * pi's own rpc.md (prompt/streamingBehavior, bash, model/thinking, sessions).
 */

import type { EngineProcess, EngineRequest, EngineResponse } from "./engine-process.js";

export interface PromptOptions {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** Required while the agent is streaming. */
  streamingBehavior?: "steer" | "followUp";
}

export async function prompt(
  engine: EngineProcess,
  opts: PromptOptions,
): Promise<EngineResponse> {
  return engine.request({ type: "prompt", ...opts });
}

/** Invoke a slash command / template / skill server-side (get_commands + prompt "/name"). */
export async function runCommand(
  engine: EngineProcess,
  commandLine: string,
): Promise<EngineResponse> {
  return engine.request({ type: "prompt", message: commandLine });
}

export async function getCommands(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "get_commands" });
}

export async function steer(
  engine: EngineProcess,
  message: string,
): Promise<EngineResponse> {
  return engine.request({ type: "steer", message });
}

export async function followUp(
  engine: EngineProcess,
  message: string,
): Promise<EngineResponse> {
  return engine.request({ type: "follow_up", message });
}

export async function abort(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "abort" });
}

export async function getState(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "get_state" });
}

export async function getMessages(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "get_messages" });
}

export async function setModel(
  engine: EngineProcess,
  provider: string,
  modelId: string,
): Promise<EngineResponse> {
  return engine.request({ type: "set_model", provider, modelId });
}

export async function getAvailableModels(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "get_available_models" });
}

export async function setThinkingLevel(
  engine: EngineProcess,
  level: string | number,
): Promise<EngineResponse> {
  return engine.request({ type: "set_thinking_level", level });
}

export async function getSessionTree(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "get_tree" });
}

export async function forkSession(
  engine: EngineProcess,
  opts: Record<string, unknown> = {},
): Promise<EngineResponse> {
  return engine.request({ type: "fork", ...opts });
}

export async function switchSession(
  engine: EngineProcess,
  sessionPath: string,
): Promise<EngineResponse> {
  return engine.request({ type: "switch_session", sessionPath });
}

export async function getSessionStats(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "get_session_stats" });
}

export async function compact(
  engine: EngineProcess,
  customPrompt?: string,
): Promise<EngineResponse> {
  return engine.request(
    customPrompt === undefined
      ? { type: "compact" }
      : { type: "compact", customInstructions: customPrompt },
  );
}

export async function runBash(
  engine: EngineProcess,
  command: string,
  requestId?: string,
): Promise<EngineResponse> {
  return engine.request({ id: requestId, type: "bash", command });
}

export async function abortBash(engine: EngineProcess): Promise<EngineResponse> {
  return engine.request({ type: "abort_bash" });
}

export type { EngineRequest };
