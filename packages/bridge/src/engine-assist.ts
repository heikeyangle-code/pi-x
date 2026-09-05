/**
 * engine-assist — pi-native one-shot text generation.
 *
 * Auto-rename and git commit-message assist used to shell out to the
 * `codex exec` / `claude -p` CLIs. In pi-only mode both are replaced by a
 * headless pi invocation (`pi --print --no-tools`), which reads the prompt
 * from stdin and prints the completion (pi-mono: main.ts, initial-message
 * tests). The model comes from BRIDGE_ASSIST_MODEL / PI_MODEL, and the pi
 * entry from PI_ENGINE_ENTRY (the same entry the bridge already manages).
 */

import { execFileSync } from "node:child_process";

function readNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

/** Assist model override; falls back to the pi engine's configured model. */
export function getAssistModel(): string {
  return (
    readNonEmptyEnv("BRIDGE_ASSIST_MODEL") ??
    readNonEmptyEnv("PI_MODEL") ??
    ""
  );
}

export interface PiPrintAssistOptions {
  cwd: string;
  prompt: string;
  model?: string;
  maxBuffer?: number;
}

/**
 * Run a one-shot pi generation (`--print`, no tools, no session) with the
 * prompt piped on stdin. Throws when PI_ENGINE_ENTRY is unset or pi fails.
 */
export function runPiPrintAssist(opts: PiPrintAssistOptions): string {
  const entry = readNonEmptyEnv("PI_ENGINE_ENTRY");
  if (entry === undefined) {
    throw new Error("PI_ENGINE_ENTRY is not set; cannot run pi assist");
  }
  const args = ["--print", "--no-tools", "--no-session"];
  const model = opts.model ?? getAssistModel();
  if (model !== "") args.push("--model", model);
  return execFileSync(entry, args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    input: opts.prompt,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
  });
}
