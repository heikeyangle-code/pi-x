/**
 * auto-rename — pi-native session auto-naming.
 *
 * CC Pocket used to generate concise session names by shelling out to the
 * `codex exec` / `claude -p` CLIs (legacy auto-rename.ts). In pi-only mode
 * the same one-shot generation runs through the pi engine itself
 * (`pi --print --no-tools --no-session`, engine-assist.ts) — the pi engine
 * does not auto-name sessions (it falls back to the first user message in its
 * session list), so this bridge-side helper restores the "auto-rename" UX the
 * app offers on `start` (autoRename: true).
 */

import { runPiPrintAssist } from "./engine-assist.js";

export const AUTO_RENAME_PROMPT_PREFIX =
  "Write a concise name for this coding-agent session.";

const AUTO_RENAME_PROMPT = `${AUTO_RENAME_PROMPT_PREFIX}

Rules:
- Output only the name. No quotes, JSON, markdown, or explanation.
- Match the primary language of the USER text. Never translate it. If USER is Japanese, the name must be Japanese.
- Write a natural, specific noun phrase rather than a sentence or a list of keywords.
- Prefer the user's intended outcome over implementation details.
- Use only the USER text to choose the name's language and subject.
- Keep it short: 2-8 English words or about 6-20 Japanese/Chinese/Korean characters when practical.
- For Japanese, use particles such as の when they improve readability; avoid unnatural keyword concatenation.
- Preserve meaningful product, library, and feature names.
- Avoid generic words such as Session, Chat, Task, Discussion, 作業, タスク, or 対応.
- Avoid trailing punctuation.`;

const MAX_TRANSCRIPT_CHARS = 2400;
const MAX_NAME_CHARS = 60;

export interface AutoRenameTranscript {
  userText: string;
}

export interface AutoRenameOptions {
  projectPath: string;
  model?: string;
  transcript: AutoRenameTranscript;
}

/**
 * Extract the first user input text from a pi history message list
 * (PiHistoryMessage[] — CC user_input shape). Returns null when there is no
 * usable user text.
 */
export function buildAutoRenameTranscript(
  history: readonly { type?: string; text?: unknown }[],
): AutoRenameTranscript | null {
  const userText = history
    .filter(
      (msg) =>
        msg !== null &&
        typeof msg === "object" &&
        msg.type === "user_input" &&
        typeof msg.text === "string",
    )
    .map((msg) => (msg.text as string).trim())
    .find(Boolean);
  if (!userText) return null;

  return {
    userText: limitText(userText, MAX_TRANSCRIPT_CHARS),
  };
}

export function buildAutoRenamePrompt(
  transcript: AutoRenameTranscript,
): string {
  return `${AUTO_RENAME_PROMPT}\n\nUSER:\n${transcript.userText}`;
}

/** Strip markdown/quote wrapping and trailing punctuation from the output. */
export function sanitizeAutoRenameName(output: string): string | null {
  const line = output
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;

  let name = line
    .replace(/^```(?:\w+)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  name = stripWrapping(name, '"');
  name = stripWrapping(name, "'");
  name = stripWrapping(name, "`");
  name = stripWrapping(name, "「", "」");
  name = stripWrapping(name, "『", "』");
  name = name
    .replace(/^[-*#\s]+/, "")
    .replace(/[。．.!！?？、,，:：;；]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) return null;
  if (/^[{[]/.test(name)) return null;
  if (/^name\s*[:=]/i.test(name)) return null;

  const chars = Array.from(name);
  if (chars.length > MAX_NAME_CHARS) {
    name = chars.slice(0, MAX_NAME_CHARS).join("").trim();
  }
  return name || null;
}

/**
 * Generate a concise session name via a headless pi invocation. Returns null
 * when pi produced no usable name.
 */
export function generateAutoRenameName(
  options: AutoRenameOptions,
): string | null {
  const output = runPiPrintAssist({
    cwd: options.projectPath,
    prompt: buildAutoRenamePrompt(options.transcript),
    model: options.model,
  });
  return sanitizeAutoRenameName(output);
}

function limitText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, maxChars).join("").trim()}...`;
}

function stripWrapping(
  value: string,
  open: string,
  close: string = open,
): string {
  if (value.startsWith(open) && value.endsWith(close)) {
    return value.slice(open.length, value.length - close.length).trim();
  }
  return value;
}
