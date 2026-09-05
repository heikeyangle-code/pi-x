/**
 * pi-sessions unit tests — history conversion, JSONL parsing, recent-session
 * scanning and the runtime registry (all pure / no pi engine spawn).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  PiSessionRegistry,
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
});
