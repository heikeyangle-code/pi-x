/**
 * pi-sessions unit tests — history conversion, JSONL parsing, recent-session
 * scanning and the runtime registry (all pure / no pi engine spawn).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  PiSessionRegistry,
  matchesRecentSessionFilters,
  parsePiSessionJsonl,
  piMessagesToHistoryMessages,
  piSessionImagesFromJsonl,
  scanPiRecentSessions,
} from "./pi-sessions.js";

describe("piMessagesToHistoryMessages", () => {
  it("converts a user text message to user_input", () => {
    const out = piMessagesToHistoryMessages([
      {
        role: "user",
        content: "hello",
        timestamp: 1_700_000_000_000,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("user_input");
    expect(out[0]?.text).toBe("hello");
    expect(out[0]?.timestamp).toMatch(/^2023-/);
  });

  it("joins multi-block text content", () => {
    const out = piMessagesToHistoryMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
    expect(out[0]?.text).toBe("ab");
  });

  it("converts assistant text/thinking/toolCall blocks", () => {
    const out = piMessagesToHistoryMessages([
      {
        role: "assistant",
        model: "claude-3-5-sonnet",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    const assistant = out[0] as Record<string, unknown>;
    expect(assistant.type).toBe("assistant");
    const message = assistant.message as Record<string, unknown>;
    expect(message.model).toBe("claude-3-5-sonnet");
    const content = message.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe("thinking");
    expect(content[1]?.type).toBe("text");
    expect(content[2]?.type).toBe("tool_use");
    expect(content[2]?.id).toBe("call-1");
    expect(content[2]?.name).toBe("bash");
  });

  it("converts toolResult to tool_result", () => {
    const out = piMessagesToHistoryMessages([
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "out" }],
        isError: false,
      },
    ]);
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.toolUseId).toBe("call-1");
    expect(out[0]?.toolName).toBe("bash");
    expect(out[0]?.content).toBe("out");
  });

  it("marks rejected tool results via permissionOutcome", () => {
    const out = piMessagesToHistoryMessages([
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: "denied",
        isError: true,
      },
    ]);
    expect(out[0]?.permissionOutcome).toBe("rejected");
  });

  it("converts bashExecution to a bash tool_result", () => {
    const out = piMessagesToHistoryMessages([
      { role: "bashExecution", output: "ls output" },
    ]);
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.toolName).toBe("bash");
    expect(out[0]?.content).toBe("ls output");
  });

  it("drops empty user messages and unknown roles", () => {
    const out = piMessagesToHistoryMessages([
      { role: "user", content: "" },
      { role: "narrator", content: "ignored" },
      null,
      "junk",
    ]);
    expect(out).toHaveLength(0);
  });

  it("falls back to provider for the assistant model", () => {
    const out = piMessagesToHistoryMessages([
      {
        role: "assistant",
        provider: "google",
        content: [{ type: "text", text: "ok" }],
      },
    ]);
    const message = (out[0] as Record<string, unknown>).message as Record<
      string,
      unknown
    >;
    expect(message.model).toBe("google");
  });

  it("preserves the pi message id as assistant uuid", () => {
    const out = piMessagesToHistoryMessages([
      {
        id: "msg-42",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    ]);
    expect(out[0]?.uuid).toBe("msg-42");
    const message = (out[0] as Record<string, unknown>).message as Record<
      string,
      unknown
    >;
    expect(message.id).toBe("msg-42");
  });
});

describe("piSessionImagesFromJsonl", () => {
  const jsonl = [
    JSON.stringify({ type: "session", id: "s1", cwd: "/p" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AAAA",
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: {
        role: "user",
        content: [{ type: "image", data: "BBBB", mimeType: "image/jpeg" }],
      },
    }),
    JSON.stringify({ type: "session_info", name: "x" }),
  ].join("\n");

  it("extracts image blocks across user messages", () => {
    const images = piSessionImagesFromJsonl(jsonl);
    expect(images).toEqual([
      { base64: "AAAA", mimeType: "image/png" },
      { base64: "BBBB", mimeType: "image/jpeg" },
    ]);
  });

  it("filters images by message id", () => {
    const images = piSessionImagesFromJsonl(jsonl, "m2");
    expect(images).toEqual([{ base64: "BBBB", mimeType: "image/jpeg" }]);
  });

  it("skips non-message lines and blocks without data", () => {
    const images = piSessionImagesFromJsonl(
      [
        JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: [{ type: "image", source: {} }] } }),
        "not json",
        JSON.stringify({ type: "session_info" }),
      ].join("\n"),
    );
    expect(images).toEqual([]);
  });
});

describe("parsePiSessionJsonl", () => {
  const header =
    '{"type":"session","version":3,"id":"sess-1","timestamp":"2025-01-02T03:04:05.000Z","cwd":"/proj"}';

  it("returns null without a session header", () => {
    expect(parsePiSessionJsonl("/x.jsonl", '{"type":"message"}\n')).toBeNull();
  });

  it("parses header, first prompt and message count", () => {
    const content = [
      header,
      '{"type":"message","timestamp":"2025-01-02T03:04:06.000Z","message":{"role":"user","content":"fix the bug","timestamp":1735787046000}}',
      '{"type":"message","timestamp":"2025-01-02T03:04:07.000Z","message":{"role":"assistant","model":"gpt-5","content":[{"type":"text","text":"done"}]}}',
    ].join("\n");
    const meta = parsePiSessionJsonl("/proj/sess-1.jsonl", content);
    expect(meta).not.toBeNull();
    expect(meta?.sessionId).toBe("sess-1");
    expect(meta?.cwd).toBe("/proj");
    expect(meta?.messageCount).toBe(2);
    expect(meta?.name).toBe("fix the bug");
    expect(meta?.model).toBe("gpt-5");
    expect(meta?.lastActivityAt).toBe(
      new Date(1735787047000).toISOString(),
    );
  });

  it("prefers an explicit session_info name", () => {
    const content = [
      header,
      '{"type":"session_info","name":"My Renamed","timestamp":"2025-01-02T03:05:00.000Z"}',
    ].join("\n");
    const meta = parsePiSessionJsonl("/proj/sess-1.jsonl", content);
    expect(meta?.name).toBe("My Renamed");
  });

  it("reads model_change for the model", () => {
    const content = [
      header,
      '{"type":"model_change","provider":"anthropic","modelId":"claude-4","timestamp":"2025-01-02T03:05:00.000Z"}',
    ].join("\n");
    const meta = parsePiSessionJsonl("/proj/sess-1.jsonl", content);
    expect(meta?.model).toBe("anthropic/claude-4");
  });

  it("skips malformed lines", () => {
    const content = [header, "not json", '{"type":"message"}'].join("\n");
    const meta = parsePiSessionJsonl("/proj/sess-1.jsonl", content);
    expect(meta).not.toBeNull();
    expect(meta?.messageCount).toBe(1);
  });
});

describe("scanPiRecentSessions", () => {
  beforeEach(() => {
    // Sandbox writes to a fresh temp dir per test invocation are not needed:
    // we only assert the empty/missing-directory behavior here, plus a
    // hand-built fixture tree created via node:fs below.
  });

  it("returns [] when the sessions dir does not exist", async () => {
    const metas = await scanPiRecentSessions("/nonexistent-home-xyz");
    expect(metas).toEqual([]);
  });

  it("sorts by last activity descending and includes mtime fallback", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
    const dir = join(root, ".pi", "agent", "sessions", "--proj--");
    mkdirSync(dir, { recursive: true });
    const older =
      '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/old"}\n' +
      '{"type":"message","timestamp":"2025-01-01T00:00:00.000Z","message":{"role":"user","content":"old one"}}\n';
    const newer =
      '{"type":"session","id":"new","timestamp":"2025-01-02T00:00:00.000Z","cwd":"/new"}\n' +
      '{"type":"message","timestamp":"2025-01-02T00:00:00.000Z","message":{"role":"user","content":"new one"}}\n';
    writeFileSync(join(dir, "old.jsonl"), older);
    writeFileSync(join(dir, "new.jsonl"), newer);
    const metas = await scanPiRecentSessions(root);
    expect(metas.map((m) => m.sessionId)).toEqual(["new", "old"]);
    expect(metas[0]?.name).toBe("new one");
  });

  it("falls back to file mtime only for activity-less sessions", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, utimesSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "pi-sessions-mtime-"));
    const dir = join(root, ".pi", "agent", "sessions", "--proj--");
    mkdirSync(dir, { recursive: true });
    // Empty session: header only, no activity entries -> mtime decides.
    const empty =
      '{"type":"session","id":"empty","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/proj"}\n';
    // Session with activity newer than its own mtime -> parsed timestamp wins.
    const active =
      '{"type":"session","id":"active","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/proj"}\n' +
      '{"type":"message","timestamp":"2025-06-01T00:00:00.000Z","message":{"role":"user","content":"hi"}}\n';
    const emptyPath = join(dir, "empty.jsonl");
    const activePath = join(dir, "active.jsonl");
    writeFileSync(emptyPath, empty);
    writeFileSync(activePath, active);
    // Pin mtimes deterministically (seconds since epoch): empty (2027) newer
    // than active's parsed activity (2025-06), active's mtime (2023) older
    // than its activity.
    utimesSync(emptyPath, 1_800_000_000, 1_800_000_000);
    utimesSync(activePath, 1_700_000_000, 1_700_000_000);
    const metas = await scanPiRecentSessions(root);
    expect(metas.map((m) => m.sessionId)).toEqual(["empty", "active"]);
    expect(metas[0]?.lastActivityAt).toBe(
      new Date(1_800_000_000_000).toISOString(),
    );
    expect(metas[1]?.lastActivityAt).toBe("2025-06-01T00:00:00.000Z");
  });

  /** Build a temp ~/.pi/agent/sessions tree with the given session files. */
  async function makeSessionTree(
    sessions: Array<{ file: string; content: string }>,
  ): Promise<string> {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "pi-sessions-filter-"));
    const dir = join(root, ".pi", "agent", "sessions", "--proj--");
    mkdirSync(dir, { recursive: true });
    for (const s of sessions) writeFileSync(join(dir, s.file), s.content);
    return root;
  }

  const bump = (iso: string) =>
    new Date(Date.parse(iso) + 1000).toISOString();
  const sessionLines = {
    named: (id: string, cwd: string, ts: string, name: string) =>
      [
        JSON.stringify({ type: "session", id, timestamp: ts, cwd }),
        JSON.stringify({ type: "session_info", name, timestamp: bump(ts) }),
      ].join("\n"),
    unnamed: (id: string, cwd: string, ts: string, prompt: string) =>
      [
        JSON.stringify({ type: "session", id, timestamp: ts, cwd }),
        JSON.stringify({
          type: "message",
          timestamp: bump(ts),
          message: { role: "user", content: prompt },
        }),
      ].join("\n"),
  };

  it("filters by searchQuery on name (explicit and fallback) and sessionId", async () => {
    const root = await makeSessionTree([
      {
        file: "a.jsonl",
        content: sessionLines.unnamed(
          "sess-needle",
          "/proj",
          "2025-02-01T00:00:00.000Z",
          "refactor the auth flow",
        ),
      },
      {
        file: "b.jsonl",
        content: sessionLines.named(
          "sess-other",
          "/proj",
          "2025-02-02T00:00:00.000Z",
          "Unrelated chat",
        ),
      },
    ]);
    const root2 = await makeSessionTree([
      {
        file: "c.jsonl",
        content: sessionLines.named(
          "sess-xyz",
          "/proj",
          "2025-02-03T00:00:00.000Z",
          "auth debugging",
        ),
      },
    ]);
    // searchQuery matches the fallback first prompt.
    const byPrompt = await scanPiRecentSessions(root, {
      searchQuery: "refactor",
    });
    expect(byPrompt.map((m) => m.sessionId)).toEqual(["sess-needle"]);
    // searchQuery matches an explicit session_info name (case-insensitive).
    const byName = await scanPiRecentSessions(root2, { searchQuery: "AUTH" });
    expect(byName.map((m) => m.sessionId)).toEqual(["sess-xyz"]);
    // searchQuery matches the session id.
    const byId = await scanPiRecentSessions(root, { searchQuery: "needle" });
    expect(byId.map((m) => m.sessionId)).toEqual(["sess-needle"]);
    // Non-matching query yields nothing.
    expect(
      await scanPiRecentSessions(root, { searchQuery: "zzz-nope" }),
    ).toEqual([]);
  });

  it("filters by namedOnly (explicit session_info names only)", async () => {
    const root = await makeSessionTree([
      {
        file: "a.jsonl",
        content: sessionLines.named(
          "sess-named",
          "/proj",
          "2025-02-01T00:00:00.000Z",
          "My Plan",
        ),
      },
      {
        file: "b.jsonl",
        content: sessionLines.unnamed(
          "sess-auto",
          "/proj",
          "2025-02-02T00:00:00.000Z",
          "fix tests",
        ),
      },
    ]);
    const all = await scanPiRecentSessions(root);
    expect(all.map((m) => m.sessionId)).toEqual(["sess-auto", "sess-named"]);
    const named = await scanPiRecentSessions(root, { namedOnly: true });
    expect(named.map((m) => m.sessionId)).toEqual(["sess-named"]);
    expect(named[0]?.name).toBe("My Plan");
  });

  it("filters by provider family (claude / codex)", async () => {
    const root = await makeSessionTree([
      {
        file: "a.jsonl",
        content:
          '{"type":"session","id":"sess-claude","timestamp":"2025-02-01T00:00:00.000Z","cwd":"/proj"}\n' +
          '{"type":"model_change","provider":"anthropic","modelId":"claude-4","timestamp":"2025-02-01T00:00:00.000Z"}\n',
      },
      {
        file: "b.jsonl",
        content:
          '{"type":"session","id":"sess-codex","timestamp":"2025-02-02T00:00:00.000Z","cwd":"/proj"}\n' +
          '{"type":"model_change","provider":"openai","modelId":"codex-1","timestamp":"2025-02-02T00:00:00.000Z"}\n',
      },
      {
        file: "c.jsonl",
        content:
          '{"type":"session","id":"sess-nomodel","timestamp":"2025-02-03T00:00:00.000Z","cwd":"/proj"}\n',
      },
    ]);
    expect(
      (await scanPiRecentSessions(root, { provider: "claude" })).map(
        (m) => m.sessionId,
      ),
    ).toEqual(["sess-claude"]);
    expect(
      (await scanPiRecentSessions(root, { provider: "codex" })).map(
        (m) => m.sessionId,
      ),
    ).toEqual(["sess-codex"]);
    // Unknown provider matches nothing.
    expect(await scanPiRecentSessions(root, { provider: "gemini" })).toEqual(
      [],
    );
  });

  it("filters by projectPath (cwd) and applies offset/limit after sorting", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "pi-sessions-pp-"));
    const base = join(root, ".pi", "agent", "sessions");
    mkdirSync(join(base, "--a--"), { recursive: true });
    mkdirSync(join(base, "--b--"), { recursive: true });
    writeFileSync(
      join(base, "--a--", "s1.jsonl"),
      sessionLines.named("s1", "/proj/a", "2025-03-01T00:00:00.000Z", "A one"),
    );
    writeFileSync(
      join(base, "--a--", "s2.jsonl"),
      sessionLines.named("s2", "/proj/a", "2025-03-02T00:00:00.000Z", "A two"),
    );
    writeFileSync(
      join(base, "--b--", "s3.jsonl"),
      sessionLines.named("s3", "/proj/b", "2025-03-03T00:00:00.000Z", "B one"),
    );

    const projA = await scanPiRecentSessions(root, {
      projectPath: "/proj/a",
    });
    expect(projA.map((m) => m.sessionId)).toEqual(["s2", "s1"]);

    // limit after sort: newest two of the three.
    const limited = await scanPiRecentSessions(root, { limit: 2 });
    expect(limited.map((m) => m.sessionId)).toEqual(["s3", "s2"]);
    // offset skips the newest, limit then caps.
    const paged = await scanPiRecentSessions(root, { offset: 1, limit: 1 });
    expect(paged.map((m) => m.sessionId)).toEqual(["s2"]);
    // offset beyond the set -> empty.
    expect(await scanPiRecentSessions(root, { offset: 10 })).toEqual([]);
  });
});

describe("matchesRecentSessionFilters", () => {
  const base: Parameters<typeof matchesRecentSessionFilters>[0] = {
    sessionId: "s1",
    named: false,
    cwd: "/proj",
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    messageCount: 1,
    filePath: "/x.jsonl",
  };

  it("matches everything when no options are given", () => {
    expect(matchesRecentSessionFilters(base, {})).toBe(true);
  });

  it("applies projectPath, namedOnly, provider and searchQuery", () => {
    const named = { ...base, named: true, name: "Fix Auth", model: "anthropic/claude-4" };
    expect(matchesRecentSessionFilters(named, { projectPath: "/other" })).toBe(false);
    expect(matchesRecentSessionFilters(named, { projectPath: "/proj" })).toBe(true);
    expect(matchesRecentSessionFilters({ ...base, named: false }, { namedOnly: true })).toBe(false);
    expect(matchesRecentSessionFilters(named, { namedOnly: true })).toBe(true);
    expect(matchesRecentSessionFilters(named, { provider: "claude" })).toBe(true);
    expect(matchesRecentSessionFilters({ ...base, model: "openai/codex-1" }, { provider: "codex" })).toBe(true);
    expect(matchesRecentSessionFilters({ ...base }, { provider: "claude" })).toBe(false);
    expect(matchesRecentSessionFilters(named, { searchQuery: "auth" })).toBe(true);
    expect(matchesRecentSessionFilters(named, { searchQuery: "nope" })).toBe(false);
    // empty query does not filter.
    expect(matchesRecentSessionFilters(base, { searchQuery: "" })).toBe(true);
  });
});

describe("PiSessionRegistry", () => {
  let registry: PiSessionRegistry;
  beforeEach(() => {
    registry = new PiSessionRegistry();
  });

  it("registers, gets and lists sessions", () => {
    registry.register("s1", "/proj", "idle");
    registry.register("s2", "/proj2", "running");
    expect(registry.get("s1")?.projectId).toBe("/proj");
    expect(registry.list()).toHaveLength(2);
  });

  it("keeps a stable createdAt across re-registration", () => {
    registry.register("s1", "/proj");
    const created = registry.get("s1")?.createdAt;
    registry.register("s1", "/proj", "running");
    expect(registry.get("s1")?.createdAt).toBe(created);
    expect(registry.get("s1")?.status).toBe("running");
  });

  it("maps project -> session and updates status", () => {
    registry.register("s1", "/proj");
    registry.setStatus("/proj", "running");
    expect(registry.getByProject("/proj")?.status).toBe("running");
  });

  it("touches updatedAt", () => {
    registry.register("s1", "/proj");
    const before = registry.get("s1")?.updatedAt ?? 0;
    registry.touch("s1");
    expect((registry.get("s1")?.updatedAt ?? 0) >= before).toBe(true);
  });

  it("renames and sets model", () => {
    registry.register("s1", "/proj");
    expect(registry.rename("s1", "New Name")).toBe(true);
    expect(registry.get("s1")?.name).toBe("New Name");
    expect(registry.rename("missing", "x")).toBe(false);
    registry.setModel("/proj", "gpt-5");
    expect(registry.get("s1")?.model).toBe("gpt-5");
  });

  it("unregisters and clears the project mapping", () => {
    registry.register("s1", "/proj");
    registry.unregister("s1");
    expect(registry.get("s1")).toBeUndefined();
    expect(registry.getByProject("/proj")).toBeUndefined();
  });

  it("keeps multiple sessions per project and returns the most recent", () => {
    registry.register("s1", "/proj");
    registry.register("s2", "/proj");
    registry.register("s3", "/proj2");
    // Most recently registered session of the project is the active one.
    expect(registry.getByProject("/proj")?.sessionId).toBe("s2");
    expect(registry.listByProject("/proj").map((e) => e.sessionId)).toEqual([
      "s1",
      "s2",
    ]);
    // Unregistering one session leaves the sibling project mapping intact.
    registry.unregister("s1");
    expect(registry.getByProject("/proj")?.sessionId).toBe("s2");
    expect(registry.listByProject("/proj").map((e) => e.sessionId)).toEqual([
      "s2",
    ]);
    expect(registry.getByProject("/proj2")?.sessionId).toBe("s3");
  });

  it("touch makes a session the active one of its project", () => {
    registry.register("s1", "/proj");
    registry.register("s2", "/proj");
    expect(registry.getByProject("/proj")?.sessionId).toBe("s2");
    registry.touch("s1");
    expect(registry.getByProject("/proj")?.sessionId).toBe("s1");
  });

  it("applies engine status/model to every session of the project", () => {
    registry.register("s1", "/proj");
    registry.register("s2", "/proj");
    registry.setStatus("/proj", "running");
    expect(registry.get("s1")?.status).toBe("running");
    expect(registry.get("s2")?.status).toBe("running");
    registry.setModel("/proj", "claude-4");
    expect(registry.get("s1")?.model).toBe("claude-4");
    expect(registry.get("s2")?.model).toBe("claude-4");
    // Unknown project is a no-op (and leaves no empty project key behind).
    registry.setStatus("/nope", "running");
    expect(registry.list()).toHaveLength(2);
  });

  it("clearProject unregisters all sessions of a project only", () => {
    registry.register("s1", "/proj");
    registry.register("s2", "/proj");
    registry.register("s3", "/proj2");
    expect(registry.clearProject("/proj")).toBe(2);
    expect(registry.get("s1")).toBeUndefined();
    expect(registry.get("s2")).toBeUndefined();
    expect(registry.list().map((e) => e.sessionId)).toEqual(["s3"]);
    expect(registry.getByProject("/proj")).toBeUndefined();
    // Clearing an unknown project returns 0.
    expect(registry.clearProject("/nope")).toBe(0);
  });
});
