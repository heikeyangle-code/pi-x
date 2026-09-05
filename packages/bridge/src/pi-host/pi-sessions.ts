/**
 * pi session surface — pi 1:1 helpers for the CC Pocket UI layer.
 *
 * pi keeps sessions as JSONL files under ~/.pi/agent/sessions/--<cwd>--/
 * (packages/session-backends, docs/session-format.md in pi-mono):
 *
 *   header: {type:"session",version:3,id,timestamp,cwd,parentSession?}
 *   entries: {type:"message",id,parentId,timestamp,message:{AgentMessage}}
 *            | {type:"session_info",...,name}
 *            | {type:"model_change",...,provider,modelId}
 *            | ...
 *
 * This module is the bridge between that on-disk/engine format and the CC
 * Pocket session messages the app renders:
 *   - piMessagesToHistoryMessages()  pi get_messages -> CC history messages
 *   - parsePiSessionJsonl()          session file -> metadata summary
 *   - scanPiRecentSessions()         ~/.pi/agent/sessions scan (home screen)
 *   - PiSessionRegistry              in-memory active pi sessions (runtime)
 *
 * Pure functions (no pi import, no engine spawn): unit-testable standalone.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// History conversion (pi AgentMessage[] -> CC history messages)
// ---------------------------------------------------------------------------

export type PiHistoryMessage = {
  type: string;
  [key: string]: unknown;
};

/** pi content blocks use type "text" | "thinking" | "toolCall" (ai package). */
function assistantBlockToCC(block: unknown): unknown | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  switch (b["type"]) {
    case "text":
      return { type: "text", text: String(b["text"] ?? "") };
    case "thinking":
      return { type: "thinking", thinking: String(b["thinking"] ?? "") };
    case "toolCall":
      return {
        type: "tool_use",
        id: String(b["id"] ?? "tool"),
        name: String(b["name"] ?? ""),
        input:
          b["input"] !== null && typeof b["input"] === "object"
            ? (b["input"] as Record<string, unknown>)
            : {},
      };
    default:
      return null;
  }
}

/** Text of a user/toolResult content field (string or TextContent[]). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      parts.push(b["text"]);
    }
  }
  return parts.join("");
}

let nonceCounter = 0;
function nonce(prefix: string): string {
  nonceCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${nonceCounter}`;
}

/**
 * Convert a pi get_messages payload (AgentMessage[]) to CC history messages
 * (user_input / assistant / tool_result) — the exact shapes the Flutter app's
 * ServerMessage.fromJson validates with strict casts (messages.dart).
 */
export function piMessagesToHistoryMessages(messages: unknown[]): PiHistoryMessage[] {
  const out: PiHistoryMessage[] = [];
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const role = String(m["role"] ?? "");
    const timestamp =
      typeof m["timestamp"] === "number"
        ? { timestamp: new Date(m["timestamp"] as number).toISOString() }
        : {};
    if (role === "user") {
      const text = contentToText(m["content"]);
      if (text === "") continue;
      out.push({ type: "user_input", text, ...timestamp });
    } else if (role === "assistant") {
      const blocks = Array.isArray(m["content"]) ? m["content"] : [];
      const content = blocks
        .map(assistantBlockToCC)
        .filter((block): block is unknown => block !== null);
      if (content.length === 0) continue;
      const model =
        typeof m["model"] === "string"
          ? m["model"]
          : typeof m["provider"] === "string"
            ? m["provider"]
            : "";
      // Keep the real pi message id so the app can correlate per-message
      // follow-ups (get_message_images) against the on-disk session.
      const piId = typeof m["id"] === "string" ? (m["id"] as string) : "";
      out.push({
        type: "assistant",
        message: {
          id: piId !== "" ? piId : nonce("pi-msg"),
          role: "assistant",
          content,
          ...(model !== "" ? { model } : {}),
        },
        ...(piId !== "" ? { uuid: piId } : {}),
        ...timestamp,
      });
    } else if (role === "toolResult") {
      out.push({
        type: "tool_result",
        toolUseId: String(m["toolCallId"] ?? "tool"),
        toolName:
          typeof m["toolName"] === "string" ? m["toolName"] : undefined,
        content: contentToText(m["content"]),
        ...(m["isError"] === true ? { permissionOutcome: "rejected" } : {}),
        ...timestamp,
      });
    } else if (role === "bashExecution") {
      out.push({
        type: "tool_result",
        toolUseId: "bash",
        toolName: "bash",
        content: String(m["output"] ?? ""),
        ...timestamp,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session file parsing (pi JSONL v3/v4)
// ---------------------------------------------------------------------------

/**
 * Extract the AgentMessage[] stored in a pi session JSONL (the `message`
 * field of every message entry). Reuses the same conversion path as the
 * engine's get_messages so on-disk history matches engine history.
 */
export function piSessionMessagesFromJsonl(content: string): unknown[] {
  const out: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    if (String(entry["type"] ?? "") !== "message") continue;
    const msg = entry["message"];
    if (msg !== null && typeof msg === "object") out.push(msg);
  }
  return out;
}

/** CC history messages from a pi session file (engine not required). */
export function piSessionFileToHistoryMessages(
  content: string,
): PiHistoryMessage[] {
  return piMessagesToHistoryMessages(piSessionMessagesFromJsonl(content));
}

// ---------------------------------------------------------------------------
// Image extraction (pi session JSONL -> base64 image refs)
// ---------------------------------------------------------------------------

export interface PiSessionImage {
  base64: string;
  mimeType: string;
}

/**
 * Extract base64 image blocks from a pi session JSONL. Pi stores pasted
 * images as content blocks `{type:"image", source:{type:"base64",
 * media_type, data}}` on user/toolResult messages (ai package, image tool
 * result tests). When `messageId` is given, only images on that message
 * entry are returned; otherwise all user-message images are returned.
 */
export function piSessionImagesFromJsonl(
  content: string,
  messageId?: string,
): PiSessionImage[] {
  const out: PiSessionImage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    if (String(entry["type"] ?? "") !== "message") continue;
    if (messageId !== undefined && String(entry["id"] ?? "") !== messageId) {
      continue;
    }
    const msg = entry["message"];
    if (msg === null || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const contentBlocks = Array.isArray(m["content"]) ? m["content"] : [];
    for (const block of contentBlocks) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (String(b["type"] ?? "") !== "image") continue;
      const source =
        b["source"] !== null && typeof b["source"] === "object"
          ? (b["source"] as Record<string, unknown>)
          : undefined;
      const data = String(source?.["data"] ?? b["data"] ?? "");
      if (data === "") continue;
      const mimeType = String(
        source?.["media_type"] ?? b["mimeType"] ?? b["mediaType"] ?? "",
      );
      out.push({ base64: data, mimeType });
    }
  }
  return out;
}

export interface PiSessionMeta {
  sessionId: string;
  /** User-assigned name (session_info) or the first user prompt. */
  name?: string;
  /** Absolute project path (header.cwd). */
  cwd: string;
  /** ISO timestamps. */
  createdAt: string;
  lastActivityAt: string;
  model?: string;
  messageCount: number;
  filePath: string;
}

/**
 * Parse one pi session JSONL file into a metadata summary. Returns null when
 * the file has no session header (not a pi session).
 */
export function parsePiSessionJsonl(
  filePath: string,
  content: string,
): PiSessionMeta | null {
  let header: Record<string, unknown> | null = null;
  let name: string | undefined;
  let firstUserText: string | undefined;
  let model: string | undefined;
  let messageCount = 0;
  let lastActivity = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const type = String(entry["type"] ?? entry["kind"] ?? "");
    if (header === null && (type === "session" || type === "header")) {
      header = entry;
      continue;
    }
    const ts =
      typeof entry["timestamp"] === "string"
        ? Date.parse(entry["timestamp"])
        : Number.NaN;

    if (type === "session_info") {
      if (typeof entry["name"] === "string") {
        name = entry["name"] as string;
      }
      if (Number.isFinite(ts) && ts > lastActivity) lastActivity = ts;
      continue;
    }
    if (type === "model_change") {
      const provider = String(entry["provider"] ?? "");
      const modelId = String(entry["modelId"] ?? "");
      if (provider !== "" && modelId !== "") model = `${provider}/${modelId}`;
      if (Number.isFinite(ts) && ts > lastActivity) lastActivity = ts;
      continue;
    }
    if (type === "message") {
      messageCount += 1;
      const msg = entry["message"] as Record<string, unknown> | undefined;
      if (msg !== null && typeof msg === "object") {
        const role = String(msg["role"] ?? "");
        const mt =
          typeof msg["timestamp"] === "number"
            ? (msg["timestamp"] as number)
            : ts;
        if (Number.isFinite(mt) && mt > lastActivity) {
          lastActivity = mt;
        }
        if (role === "user" && firstUserText === undefined) {
          const text = contentToText(msg["content"]);
          if (text !== "") firstUserText = text;
        }
        if (model === undefined && role === "assistant") {
          if (typeof msg["model"] === "string") model = msg["model"];
          else if (typeof msg["provider"] === "string") model = msg["provider"];
        }
      }
      continue;
    }
    if (Number.isFinite(ts) && ts > lastActivity) lastActivity = ts;
  }

  if (header === null) return null;

  const id = String(header["id"] ?? basename(filePath, ".jsonl"));
  const cwd = String(header["cwd"] ?? "");
  const headerTs =
    typeof header["timestamp"] === "string"
      ? Date.parse(header["timestamp"])
      : typeof header["createdAt"] === "number"
        ? (header["createdAt"] as number)
        : Number.NaN;
  const createdMs = Number.isFinite(headerTs) ? headerTs : 0;
  const lastMs = Number.isFinite(lastActivity) ? lastActivity : createdMs;

  const fallbackName = firstUserText
    ? firstUserText.replace(/\s+/g, " ").trim().slice(0, 200)
    : undefined;

  return {
    sessionId: id,
    name: name ?? fallbackName,
    cwd,
    createdAt: new Date(createdMs).toISOString(),
    lastActivityAt: new Date(lastMs).toISOString(),
    model,
    messageCount,
    filePath,
  };
}

// ---------------------------------------------------------------------------
// Recent sessions scan (~/.pi/agent/sessions/--<cwd>--/<file>.jsonl)
// ---------------------------------------------------------------------------

/**
 * Scan all pi session files under ~/.pi/agent/sessions, newest activity first.
 * Mirrors pi's own layout (getSessionsDir(): ~/.pi/agent/sessions) so the
 * home screen's "recent sessions" reflects exactly what the engine persists.
 */
export async function scanPiRecentSessions(
  piHome: string,
): Promise<PiSessionMeta[]> {
  const sessionsDir = join(piHome, ".pi", "agent", "sessions");
  const out: PiSessionMeta[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(sessionsDir);
  } catch {
    return [];
  }
  for (const dirName of projectDirs) {
    const dir = join(sessionsDir, dirName);
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const fileName of files) {
      if (!fileName.endsWith(".jsonl")) continue;
      const file = join(dir, fileName);
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const meta = parsePiSessionJsonl(file, content);
      if (meta === null) continue;
      // File mtime is the last resort for "modified" (empty session files).
      try {
        const st = await stat(file);
        if (st.mtimeMs > Date.parse(meta.lastActivityAt)) {
          meta.lastActivityAt = new Date(st.mtimeMs).toISOString();
        }
      } catch {
        // keep parsed activity time
      }
      out.push(meta);
    }
  }
  out.sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Active session registry (runtime sessions the app opened via `start`)
// ---------------------------------------------------------------------------

export interface PiSessionEntry {
  /** CC Pocket session id (app-generated, from `start`). */
  sessionId: string;
  /** pi project = cwd (absolute path). */
  projectId: string;
  status: "idle" | "running";
  createdAt: number;
  updatedAt: number;
  name?: string;
  model?: string;
}

/** Tracks pi sessions known to the bridge (one per opened project). */
export class PiSessionRegistry {
  private readonly sessions = new Map<string, PiSessionEntry>();
  private readonly byProject = new Map<string, string>();

  register(
    sessionId: string,
    projectId: string,
    status: PiSessionEntry["status"] = "idle",
  ): void {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      sessionId,
      projectId,
      status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      name: existing?.name,
      model: existing?.model,
    });
    this.byProject.set(projectId, sessionId);
  }

  unregister(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    if (this.byProject.get(entry.projectId) === sessionId) {
      this.byProject.delete(entry.projectId);
    }
    this.sessions.delete(sessionId);
  }

  get(sessionId: string): PiSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  getByProject(projectId: string): PiSessionEntry | undefined {
    const id = this.byProject.get(projectId);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  list(): PiSessionEntry[] {
    return [...this.sessions.values()];
  }

  setStatus(projectId: string, status: PiSessionEntry["status"]): void {
    const entry = this.getByProject(projectId);
    if (entry === undefined) return;
    entry.status = status;
    entry.updatedAt = Date.now();
  }

  touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    entry.updatedAt = Date.now();
  }

  rename(sessionId: string, name: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return false;
    entry.name = name;
    entry.updatedAt = Date.now();
    return true;
  }

  setModel(projectId: string, model: string): void {
    const entry = this.getByProject(projectId);
    if (entry === undefined) return;
    entry.model = model;
  }
}
