/**
 * Pi X config surface — app-controlled engine launch options.
 *
 * Lives at ~/.pi/agent/pix-config.json (pi home). The mobile app updates it
 * via PiGateway control ops (`get_pix_config` / `update_pix_config`); the
 * gateway passes `engineArgs` into every engine process spawn as argv appended
 * after `--mode rpc` (EngineProcessOptions.args).
 *
 * Engine args are only read at process start, so a change takes effect on the
 * next engine spawn — the app calls `restart_engine` (PiGateway control op)
 * to apply them immediately. This mirrors how `--system-prompt`,
 * `--append-system-prompt`, `--no-context-files`, `--no-skills`,
 * `--no-extensions`, `--tools`/`--exclude-tools` behave in pi's CLI: they are
 * launch-time switches.
 *
 * Pure fs/json: no pi import, safe to typecheck & unit-test standalone.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface PixConfig {
  /** Extra argv appended after `--mode rpc` on every engine spawn. */
  engineArgs?: string[];
}

export const DEFAULT_PIX_CONFIG: PixConfig = {};

function normalize(input: unknown): PixConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_PIX_CONFIG };
  }
  const raw = input as Record<string, unknown>;
  return {
    engineArgs: Array.isArray(raw.engineArgs)
      ? raw.engineArgs.map(String).filter((s) => s.length > 0)
      : undefined,
  };
}

export class PixConfigFile {
  constructor(private readonly file: string) {}

  async load(): Promise<PixConfig> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return normalize(parsed);
    } catch {
      return { ...DEFAULT_PIX_CONFIG };
    }
  }

  /** Merge a partial patch; returns the full resulting config. */
  async update(patch: Partial<PixConfig>): Promise<PixConfig> {
    const current = await this.load();
    const next: PixConfig = {
      ...current,
      ...(patch.engineArgs === undefined
        ? {}
        : { engineArgs: patch.engineArgs.map(String).filter((s) => s.length > 0) }),
    };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}
