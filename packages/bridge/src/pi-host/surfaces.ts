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

import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

  /**
   * Merge a batch of models into a provider by id (docs/models.md upsert
   * semantics: same id replaces, new ids append, untouched models are kept).
   * Creates the provider when missing; provider-level fields are preserved.
   */
  async importModels(providerId: string, models: CustomModelSpec[]): Promise<void> {
    const providers = await this.loadProviders();
    const provider = providers[providerId] ?? {};
    const byId = new Map<string, CustomModelSpec>();
    for (const existing of provider.models ?? []) {
      byId.set(existing.id, existing);
    }
    for (const incoming of models) {
      byId.set(incoming.id, incoming);
    }
    provider.models = [...byId.values()];
    await this.upsertProvider(providerId, provider);
  }

  /**
   * Merge providers from pasted JSON (the models.json "providers" object or a
   * single provider object) into the file. Provider-level fields overwrite;
   * models upsert by id within each provider. Unknown input is rejected.
   * Returns the provider ids that were touched.
   */
  async importProvidersJson(jsonText: string): Promise<string[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("invalid JSON");
    }
    let providers: Record<string, unknown>;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj["providers"] !== undefined) {
        if (obj["providers"] === null || typeof obj["providers"] !== "object" || Array.isArray(obj["providers"])) {
          throw new Error("invalid providers object");
        }
        providers = obj["providers"] as Record<string, unknown>;
      } else {
        // Bare single-provider object, e.g. {"ollama": {...}}.
        providers = obj;
      }
    } else {
      throw new Error("expected a providers object");
    }
    const root = (await readJsonObject(this.file)) ?? {};
    const current = (root["providers"] as Record<string, unknown> | undefined) ?? {};
    const touched: string[] = [];
    for (const [id, incomingValue] of Object.entries(providers)) {
      if (incomingValue === null || typeof incomingValue !== "object" || Array.isArray(incomingValue)) {
        continue; // skip malformed entries instead of corrupting the file
      }
      const incoming = incomingValue as Record<string, unknown>;
      const existing = (current[id] ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...existing };
      for (const [key, value] of Object.entries(incoming)) {
        if (key === "models" && Array.isArray(value)) {
          const byId = new Map<string, unknown>();
          if (Array.isArray(existing["models"])) {
            for (const model of existing["models"]) {
              if (model !== null && typeof model === "object" && !Array.isArray(model)) {
                byId.set((model as Record<string, unknown>)["id"] as string, model);
              }
            }
          }
          for (const model of value) {
            if (model !== null && typeof model === "object" && !Array.isArray(model)) {
              const record = model as Record<string, unknown>;
              if (typeof record["id"] === "string" && record["id"].length > 0) {
                byId.set(record["id"], model);
              }
            }
          }
          merged["models"] = [...byId.values()];
        } else {
          merged[key] = value;
        }
      }
      current[id] = merged;
      touched.push(id);
    }
    await writeJsonObject(this.file, { ...root, providers: current });
    return touched;
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

/** Enumerate `*.json` files under `root` (themes etc.); missing dir = empty. */
export async function listJsonFiles(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const full = join(root, name);
    try {
      if ((await stat(full)).isFile()) files.push(full);
    } catch {
      // ignore unreadable entries
    }
  }
  return files.sort();
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

/** A discovered extension (pi 1:1: global agentDir/extensions + project .pi/extensions). */
export interface ExtensionInfo {
  name: string;
  scope: "global" | "project";
}

/**
 * List extension directories across roots. Matches the engine's discovery
 * order (packages/coding-agent/src/core/extensions/loader.ts): project-local
 * first, then global.
 */
export async function listExtensionInfos(roots: SkillRoot[]): Promise<ExtensionInfo[]> {
  const out: ExtensionInfo[] = [];
  for (const { scope, dir } of roots) {
    for (const full of await listResourceDirs(dir)) {
      out.push({ name: full.split("/").pop() ?? full, scope });
    }
  }
  return out;
}

/** A discovered prompt template (.md, official prompt-templates.ts semantics). */
export interface PromptTemplateInfo {
  name: string;
  scope: "global" | "project";
  /** frontmatter `description:` or first non-empty body line (truncated to 60). */
  description?: string;
  /** frontmatter `argument-hint:` when present. */
  argumentHint?: string;
  /** Absolute file path (the app can `read_prompt_template` it). */
  path: string;
}

/** Name of a template file (basename without .md); "" for non-.md names. */
export function templateNameFromFile(file: string): string {
  return basename(file).replace(/\.md$/, "");
}

/**
 * Parse a template markdown exactly like pi's loadTemplateFromFile:
 * description from frontmatter, else the first non-empty body line
 * (truncated to 60 chars with "...").
 */
export function parseTemplateMarkdown(
  content: string,
  fileName: string,
  scope: PromptTemplateInfo["scope"],
  path: string,
): PromptTemplateInfo | null {
  const name = templateNameFromFile(fileName);
  if (!name) return null;
  const trimmed = content.trimStart();
  let front: string | null = null;
  let body = content;
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end >= 0) {
      front = trimmed.slice(3, end);
      body = trimmed.slice(end + 4);
    }
  }
  let description = front ? /^description\s*:\s*(.*)$/m.exec(front)?.[1]?.trim() ?? "" : "";
  description = description.replace(/^["']|["']$/g, "");
  if (!description) {
    const firstLine = body.split("\n").find((line) => line.trim());
    if (firstLine) {
      description = firstLine.trim().slice(0, 60);
      if (firstLine.trim().length > 60) description += "...";
    }
  }
  const argumentHint = front
    ? /^argument-hint\s*:\s*(.*)$/m.exec(front)?.[1]?.trim() || undefined
    : undefined;
  return { name, scope, description: description || undefined, argumentHint, path };
}

/**
 * List prompt templates from the official roots (agentDir/prompts global +
 * cwd/.pi/prompts project), non-recursive, mirroring loadTemplatesFromDir.
 */
export async function listPromptTemplates(
  cwd: string,
  piHome: string,
): Promise<PromptTemplateInfo[]> {
  const files = piAgentFiles(piHome);
  const roots: Array<{ scope: PromptTemplateInfo["scope"]; dir: string }> = [
    { scope: "global", dir: files.agentPromptsDir },
    { scope: "project", dir: join(cwd, ".pi", "prompts") },
  ];
  const out: PromptTemplateInfo[] = [];
  for (const { scope, dir } of roots) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".md")) continue;
      const full = join(dir, name);
      try {
        if (!(await stat(full)).isFile()) continue;
        const info = parseTemplateMarkdown(
          await readFile(full, "utf8"),
          name,
          scope,
          full,
        );
        if (info) out.push(info);
      } catch {
        // unreadable entries are skipped, matching the engine
      }
    }
  }
  return out;
}

/** Guard a template name for path safety; appends .md when missing. */
export function sanitizeTemplateName(name: string): string | null {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === ".." ||
    trimmed.includes("..")
  ) {
    return null;
  }
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

/** Write (or overwrite) a prompt template; mkdirs the scope dir. */
export async function writePromptTemplate(
  cwd: string,
  piHome: string,
  scope: "global" | "project",
  name: string,
  content: string,
): Promise<string> {
  const fileName = sanitizeTemplateName(name);
  if (!fileName) throw new Error("invalid_template_name");
  const files = piAgentFiles(piHome);
  const dir = scope === "project" ? join(cwd, ".pi", "prompts") : files.agentPromptsDir;
  await mkdir(dir, { recursive: true });
  const file = join(dir, fileName);
  await writeFile(file, content, "utf8");
  return file;
}

/** Delete a prompt template; returns false when it did not exist. */
export async function deletePromptTemplate(
  cwd: string,
  piHome: string,
  scope: "global" | "project",
  name: string,
): Promise<boolean> {
  const fileName = sanitizeTemplateName(name);
  if (!fileName) throw new Error("invalid_template_name");
  const files = piAgentFiles(piHome);
  const dir = scope === "project" ? join(cwd, ".pi", "prompts") : files.agentPromptsDir;
  const file = join(dir, fileName);
  try {
    await rm(file, { force: false });
    return true;
  } catch {
    return false;
  }
}

/** pi home layout helper: settings/models paths under ~/.pi/agent. */
export function piAgentFiles(piHome: string): {
  agent: string;
  settings: string;
  models: string;
  extensionsDir: string;
  skillsDir: string;
  /** Official prompt template dir (~/.pi/agent/prompts, prompt-templates.ts). */
  agentPromptsDir: string;
  /** Custom themes dir (~/.pi/agent/themes, theme.ts getCustomThemesDir). */
  themesDir: string;
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
    agentPromptsDir: join(agent, "prompts"),
    themesDir: join(agent, "themes"),
    npmDir: join(agent, "npm"),
    gitDir: join(agent, "git"),
    pixConfig: join(agent, "pix-config.json"),
    systemPrompt: join(agent, "SYSTEM.md"),
    appendSystemPrompt: join(agent, "APPEND_SYSTEM.md"),
  };
}

/**
 * Theme discovery (pi 1:1: theme.ts getAvailableThemesWithPaths).
 *
 * Built-in themes are the engine's packaged dark/light palettes; custom
 * themes are `*.json` files in ~/.pi/agent/themes whose JSON declares a
 * `name` and a `colors` object (ThemeJsonSchema). The entry marked selected
 * matches `settings.theme`.
 */
export interface ThemeInfo {
  name: string;
  path?: string;
  builtin: boolean;
  selected: boolean;
}

const BUILTIN_THEME_NAMES = ["dark", "light"] as const;

/** Read a custom theme's declared name from its JSON; undefined when invalid. */
export async function readThemeName(file: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const name = (parsed as Record<string, unknown>)["name"];
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/** List built-in + custom themes; selected mirrors settings.theme. */
export async function listThemes(
  piHome: string,
  selectedName?: string,
): Promise<ThemeInfo[]> {
  const themesDir = piAgentFiles(piHome).themesDir;
  const out: ThemeInfo[] = [];
  const seen = new Set<string>();
  const push = (info: ThemeInfo) => {
    if (seen.has(info.name)) return;
    seen.add(info.name);
    out.push(info);
  };
  for (const name of BUILTIN_THEME_NAMES) {
    push({ name, builtin: true, selected: name === selectedName });
  }
  // Custom themes are `*.json` files in ~/.pi/agent/themes (pi 1:1:
  // theme.ts getAvailableThemesWithPaths enumerates the themes dir and
  // parses each file; broken JSON is skipped).
  for (const full of await listJsonFiles(themesDir)) {
    const name = await readThemeName(full);
    if (name) {
      push({ name, path: full, builtin: false, selected: name === selectedName });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Write a custom theme file (~/.pi/agent/themes/<name>.json). Mirrors pi's
 * ThemeJsonSchema validation: the JSON must be an object with a `name`
 * string and a `colors` object; it is stored as-is otherwise.
 * Returns the written file path.
 */
export async function writeCustomTheme(
  piHome: string,
  name: string,
  themeJson: unknown,
): Promise<string> {
  const clean = name.trim().replace(/\.json$/, "");
  if (!/^[\w.-]+$/.test(clean)) {
    throw new Error(`Invalid theme name: ${name}`);
  }
  if (themeJson === null || typeof themeJson !== "object" || Array.isArray(themeJson)) {
    throw new Error("Theme must be a JSON object");
  }
  const record = themeJson as Record<string, unknown>;
  const declared = record["name"];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new Error("Theme JSON must declare a \"name\" string");
  }
  if (record["colors"] === null || typeof record["colors"] !== "object") {
    throw new Error("Theme JSON must declare a \"colors\" object");
  }
  const file = join(piAgentFiles(piHome).themesDir, `${clean}.json`);
  await writeJsonObject(file, themeJson);
  return file;
}

/** Remove a custom theme file; returns false when absent/built-in. */
export async function deleteCustomTheme(piHome: string, name: string): Promise<boolean> {
  const file = join(piAgentFiles(piHome).themesDir, `${name.replace(/\.json$/, "")}.json`);
  try {
    await rm(file, { force: false });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context files (AGENTS.md / CLAUDE.md quick edit, pi docs §6.1 #13).
//
// pi merges AGENTS.md/CLAUDE.md walking UP the directory tree from the
// project root. The app's quick-edit entry always targets the project-local
// file (cwd/<name>) — a predictable, merge-friendly edit surface — while
// `findNearestContextFile` reports which parent copy currently feeds the
// engine so the UI can warn when a higher-up file exists.
// ---------------------------------------------------------------------------

/** Context file names pi discovers (docs: "目录向上合并", --no-context-files). */
export const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Canonicalize a context file name; null for anything else. */
export function sanitizeContextFileName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const canonical = CONTEXT_FILE_NAMES.find(
    (candidate) => candidate.toLowerCase() === name.trim().toLowerCase(),
  );
  return canonical ?? null;
}

async function existsFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the nearest existing `<name>` file walking up from `cwd` to the
 * filesystem root (pi's upward merge). Returns the absolute path or null.
 */
export async function findNearestContextFile(
  cwd: string,
  name: string,
): Promise<string | null> {
  const clean = sanitizeContextFileName(name);
  if (!clean) return null;
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, clean);
    if (await existsFile(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ContextFileInfo {
  /** Canonical file name ("AGENTS.md" | "CLAUDE.md"). */
  name: string;
  /** Nearest existing file walking up from the project root (null = none). */
  path: string | null;
  /** Project-local write target: <cwd>/<name>. */
  targetPath: string;
}

/** Enumerate AGENTS.md/CLAUDE.md for a project, per pi's upward merge. */
export async function findContextFiles(cwd: string): Promise<ContextFileInfo[]> {
  const out: ContextFileInfo[] = [];
  for (const name of CONTEXT_FILE_NAMES) {
    out.push({
      name,
      path: await findNearestContextFile(cwd, name),
      targetPath: join(cwd, name),
    });
  }
  return out;
}
