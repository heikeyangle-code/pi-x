import { describe, it, expect } from "vitest";
import { piFrameToServerMessages, inboundToActions, type PiFrame } from "./cc-adapter.js";

describe("cc-adapter piFrameToServerMessages", () => {
  it("maps text_delta to stream_delta(text)", () => {
    const out = piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" } });
    expect(out).toEqual([{ type: "stream_delta", text: "Hi" }]);
  });

  it("maps thinking_delta to thinking_delta(text)", () => {
    const out = piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "reason" } });
    expect(out).toEqual([{ type: "thinking_delta", text: "reason" }]);
  });

  it("emits nothing for text_start/thinking_start/thinking_end (streaming boundaries)", () => {
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } })).toEqual([]);
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } })).toEqual([]);
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } })).toEqual([]);
  });

  it("maps text_end to a canonical assistant message", () => {
    const out = piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "done" } });
    expect(out).toEqual([
      {
        type: "assistant",
        message: {
          id: expect.stringMatching(/^a-/),
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "",
        },
      },
    ]);
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "" } })).toEqual([]);
  });

  it("maps toolcall_start/end to canonical tool_result and folds toolcall_delta", () => {
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "t1", toolName: "bash" } }))
      .toEqual([{ type: "tool_result", toolUseId: "t1", content: "", toolName: "bash" }]);
    // Argument chunks stream as deltas; they must not spawn bubbles.
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", id: "t1", delta: "{\"cmd\":" } }))
      .toEqual([]);
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", id: "t1", toolCall: { id: "t1", name: "bash", input: { cmd: "ls" } } } }))
      .toEqual([{ type: "tool_result", toolUseId: "t1", content: "{\"cmd\":\"ls\"}", toolName: "bash" }]);
  });

  it("maps extension_ui_request(confirm) to canonical permission_request", () => {
    const out = piFrameToServerMessages({ type: "extension_ui_request", id: "u1", method: "confirm", title: "T", message: "M", options: ["a", "b"] });
    expect(out).toEqual([
      {
        type: "permission_request",
        toolUseId: "u1",
        toolName: "confirm",
        input: { title: "T", message: "M", options: ["a", "b"] },
      },
    ]);
  });

  it("ignores fire-and-forget extension UI methods (no approval card)", () => {
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      expect(piFrameToServerMessages({ type: "extension_ui_request", id: "u1", method })).toEqual([]);
    }
  });

  it("maps lifecycle frames to canonical status states", () => {
    expect(piFrameToServerMessages({ type: "agent_start" })).toEqual([{ type: "status", status: "running" }]);
    expect(piFrameToServerMessages({ type: "agent_settled" })).toEqual([{ type: "status", status: "idle" }]);
    expect(piFrameToServerMessages({ type: "agent_end" })).toEqual([{ type: "status", status: "idle" }]);
    expect(piFrameToServerMessages({ type: "engine_exit" })).toEqual([{ type: "status", status: "idle" }]);
  });

  it("keeps UI running when agent_end carries willRetry", () => {
    expect(piFrameToServerMessages({ type: "agent_end", willRetry: true })).toEqual([]);
    expect(piFrameToServerMessages({ type: "agent_end", willRetry: false })).toEqual([{ type: "status", status: "idle" }]);
  });

  it("maps bash_execution_update delta to canonical tool_result using the command id", () => {
    expect(piFrameToServerMessages({ type: "bash_execution_update", id: "req-1", delta: "+ ls" }))
      .toEqual([{ type: "tool_result", toolUseId: "req-1", content: "+ ls", toolName: "bash" }]);
    expect(piFrameToServerMessages({ type: "bash_execution_update", delta: "no-id" }))
      .toEqual([{ type: "tool_result", toolUseId: "bash", content: "no-id", toolName: "bash" }]);
  });

  it("maps tool_execution frames to canonical tool_result using toolCallId", () => {
    expect(piFrameToServerMessages({ type: "tool_execution_start", toolCallId: "call_1", toolName: "write", args: { path: "a.ts" } }))
      .toEqual([{ type: "tool_result", toolUseId: "call_1", content: "", toolName: "write" }]);
    expect(piFrameToServerMessages({ type: "tool_execution_update", toolCallId: "call_1", toolName: "write", partialResult: { content: [{ type: "text", text: "partial" }] } }))
      .toEqual([]);
    expect(piFrameToServerMessages({ type: "tool_execution_end", toolCallId: "call_1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false }))
      .toEqual([{ type: "tool_result", toolUseId: "call_1", content: "ok", toolName: "write" }]);
  });

  it("extracts text from tool result content blocks instead of stringifying the object", () => {
    expect(piFrameToServerMessages({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] } }))
      .toEqual([{ type: "tool_result", toolUseId: "c", content: "line1\nline2", toolName: "bash" }]);
    // Plain-string fallback still works.
    expect(piFrameToServerMessages({ type: "tool_execution_end", toolCallId: "c2", toolName: "x", output: "legacy" }))
      .toEqual([{ type: "tool_result", toolUseId: "c2", content: "legacy", toolName: "x" }]);
  });

  it("maps compaction_start/end to tool_result cards", () => {
    const start = piFrameToServerMessages({ type: "compaction_start", reason: "threshold" });
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ type: "tool_result", toolName: "compaction" });
    expect(String(start[0].content)).toContain("压缩");

    const done = piFrameToServerMessages({ type: "compaction_end", reason: "threshold", result: { summary: "refactored auth" } });
    expect(done).toHaveLength(1);
    expect(String(done[0].content)).toContain("refactored auth");

    const aborted = piFrameToServerMessages({ type: "compaction_end", reason: "threshold", result: null, aborted: true });
    expect(String(aborted[0].content)).toContain("取消");

    const failed = piFrameToServerMessages({ type: "compaction_end", result: null, aborted: false, errorMessage: "quota exceeded" });
    expect(failed[0]).toMatchObject({ type: "error" });
    expect(String(failed[0].message)).toContain("quota exceeded");
  });

  it("maps extension_error to an error message", () => {
    const out = piFrameToServerMessages({ type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "boom" });
    expect(out).toEqual([
      { type: "error", message: expect.stringContaining("boom") as string, errorCode: "extension_error" },
    ]);
  });

  it("maps auto_retry_start/end to tool_result/error", () => {
    const start = piFrameToServerMessages({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ type: "tool_result", toolName: "auto_retry" });
    expect(String(start[0].content)).toContain("1/3");

    const ok = piFrameToServerMessages({ type: "auto_retry_end", success: true, attempt: 2 });
    expect(ok[0]).toMatchObject({ type: "tool_result", toolName: "auto_retry" });

    const fail = piFrameToServerMessages({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529" });
    expect(fail).toEqual([{ type: "error", message: expect.stringContaining("529") as string, errorCode: "auto_retry_failed" }]);
  });

  it("returns [] for unknown/no-delta frames", () => {
    expect(piFrameToServerMessages({ type: "message_update", usage: {} })).toEqual([]);
    expect(piFrameToServerMessages({ type: "something_else" })).toEqual([]);
    expect(piFrameToServerMessages({ type: "turn_start" })).toEqual([]);
    expect(piFrameToServerMessages({ type: "queue_update", steering: [], followUp: [] })).toEqual([]);
  });
});

describe("cc-adapter inboundToActions", () => {
  it("maps input to a prompt control", () => {
    const a = inboundToActions({ type: "input", text: "/skill:web" });
    expect(a).toEqual([{ kind: "control", op: "prompt", payload: { message: "/skill:web" } }]);
  });

  it("maps approve to a ui_response confirmed", () => {
    const a = inboundToActions({ type: "approve", toolUseId: "u1" });
    expect(a).toEqual([{ kind: "ui_response", uiRequestId: "u1", value: { confirmed: true } }]);
  });

  it("maps reject to a ui_response rejected", () => {
    const a = inboundToActions({ type: "reject", toolUseId: "u1" });
    expect(a).toEqual([{ kind: "ui_response", uiRequestId: "u1", value: { confirmed: false } }]);
  });

  it("maps answer to a ui_response with value", () => {
    const a = inboundToActions({ type: "answer", toolUseId: "u1", result: "42" });
    expect(a).toEqual([{ kind: "ui_response", uiRequestId: "u1", value: { value: "42" } }]);
  });

  it("maps stop_session/start to controls, unknown to none", () => {
    expect(inboundToActions({ type: "stop_session" })).toEqual([{ kind: "control", op: "abort" }]);
    expect(inboundToActions({ type: "start" })).toEqual([{ kind: "control", op: "get_state" }]);
    expect(inboundToActions({ type: "bogus" as never })).toEqual([]);
  });

  it("compiles a PiFrame literal", () => {
    const f: PiFrame = { type: "agent_start" };
    expect(piFrameToServerMessages(f).length).toBe(1);
  });
});
