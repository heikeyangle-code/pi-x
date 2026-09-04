/**
 * pi-engine 1:1 surface helpers.
 *
 * pi keeps its state in plain files; the app layer mirrors it 1:1 by
 * reading/writing the same files (engine remains the single source of truth):
 *
 *   ~/.pi/agent/settings.json   -> user settings (opaque map + known keys)
 *   ~/.pi/agent/models.json     -> custom providers/models (docs/models.md)
 *   ~/.pi/agent/{extensions,skills,theme,...} -> resource discovery (fs)
 *
 * Pure fs/json: no pi import, safe to typecheck & unit-test standalone.
 */

import { readFile, writeFile, mkdir, readdir, stat, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Custom provider API types supported by pi (docs/models.md). */
export type CustomProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface CustomProviderSpec {
  baseUrl?: string;
  api?: CustomProviderApi;
  apiKey?: string;
  models?: CustomModelSpec[];
}

export interface CustomModelSpec {
  id: string;
  [key: string]: unknown;
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Atomically write a JSON object (tmp + rename). */
async function writeJsonObject(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export interface SettingsFileLike {
  load(): Promise<Record<string, unknown>>;
  update(patch: Record<string, unknown>): Promise<void>;
}

/** ~/.pi/agent/settings.json — user settings mirror (opaque + merge). */
export class SettingsFile implements SettingsFileLike {
  constructor(private readonly file: string) {}

  async load(): Promise<Record<string, unknown>> {
    return (await readJsonObject(this.file)) ?? {};
  }

  /** Deep-ish merge of known scalar keys; arrays/objects replaced wholesale. */
  async update(patch: Record<string, unknown>): Promise<void> {
    const current = await this.load();
    const next = { ...current, ...patch };
    await writeJsonObject(this.file, next);
  }
}

/** ~/.pi/agent/models.json — custom providers/models (docs/models.md). */
export class ModelsFile {
  constructor(private readonly file: string) {}

  async loadProviders(): Promise<Record<string, CustomProviderSpec>> {
    const root = (await readJsonObject(this.file)) ?? {};
    const providers = root["providers"];
    if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
      return providers as Record<string, CustomProviderSpec>;
    }
    return {};
  }

  async upsertProvider(id: string, spec: CustomProviderSpec): Promise<void> {
    const root = (await readJsonObject(this.file)) ?? {};
    const providers = (root["providers"] as Record<string, unknown> | undefined) ?? {};
    (providers as Record<string, unknown>)[id] = spec;
    await writeJsonObject(this.file, { ...root, providers });
  }

  async removeProvider(id: string): Promise<boolean> {
    const root = (await readJsonObject(this.file)) ?? {};
    const providers = root["providers"] as Record<string, unknown> | undefined;
    if (providers === undefined || !(id in providers)) return false;
    delete providers[id];
    await writeJsonObject(this.file, { ...root, providers });
    return true;
  }

  async addModel(providerId: string, model: CustomModelSpec): Promise<void> {
    const providers = await this.loadProviders();
    const provider = providers[providerId] ?? {};
    provider.models = [...(provider.models ?? []), model];
    await this.upsertProvider(providerId, provider);
  }
}

/** Directory-style resource discovery (extensions/skills/prompt templates). */
export async function listResourceDirs(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries) {
    const full = join(root, name);
    try {
      if ((await stat(full)).isDirectory()) dirs.push(full);
    } catch {
      // ignore unreadable entries
    }
  }
  return dirs.sort();
}

/** Whether a markdown file looks like an Agent-skills skill (frontmatter + description). */
export function looksLikeSkillMarkdown(content: string): boolean {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return false;
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) return false;
  const front = trimmed.slice(3, end);
  return /^[\s\S]*description\s*:/m.test(front);
}

/** A discovered skill (docs/ENGINE-UI-SURFACES §6.1): global or project scope. */
export interface SkillInfo {
  name: string;
  scope: "global" | "project";
  /** First `description:` line of SKILL.md frontmatter, when present. */
  description?: string;
}

/** Skill search roots (global ~/.pi/agent/skills + project .pi/skills). */
export type SkillRoot = { scope: SkillInfo["scope"]; dir: string };

/** First `description:` line of a skill's SKILL.md frontmatter. */
async function skillDescription(dir: string): Promise<string | undefined> {
  try {
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("---")) return undefined;
    const end = trimmed.indexOf("\n---", 3);
    if (end < 0) return undefined;
    const front = trimmed.slice(3, end);
    const m = /^description\s*:\s*(.*)$/m.exec(front);
    if (!m) return undefined;
    const text = m[1].trim().replace(/^["']|["']$/g, "");
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** List skills across roots, global first, each with a frontmatter description. */
export async function listSkillInfos(roots: SkillRoot[]): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];
  for (const { scope, dir } of roots) {
    for (const full of await listResourceDirs(dir)) {
      out.push({
        name: full.split("/").pop() ?? full,
        scope,
        description: await skillDescription(full),
      });
    }
  }
  return out;
}

/** Read a skill's SKILL.md body; null when missing/unreadable. */
export async function readSkillMarkdown(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/** pi home layout helper: settings/models paths under ~/.pi/agent. */
export function piAgentFiles(piHome: string): {
  agent: string;
  settings: string;
  models: string;
  extensionsDir: string;
  skillsDir: string;
  npmDir: string;
  gitDir: string;
  /** Pi X app-controlled engine launch options (~/.pi/agent/pix-config.json). */
  pixConfig: string;
  /** pi official system prompt overrides (~/.pi/agent/SYSTEM.md / APPEND_SYSTEM.md). */
  systemPrompt: string;
  appendSystemPrompt: string;
} {
  const agent = join(piHome, ".pi", "agent");
  return {
    agent,
    settings: join(agent, "settings.json"),
    models: join(agent, "models.json"),
    extensionsDir: join(agent, "extensions"),
    skillsDir: join(agent, "skills"),
    npmDir: join(agent, "npm"),
    gitDir: join(agent, "git"),
    pixConfig: join(agent, "pix-config.json"),
    systemPrompt: join(agent, "SYSTEM.md"),
    appendSystemPrompt: join(agent, "APPEND_SYSTEM.md"),
  };
}
