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

  it("emits nothing for text_start/thinking_start (streaming starts on first delta)", () => {
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } })).toEqual([]);
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } })).toEqual([]);
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

  it("maps toolcall_start/end to canonical tool_result", () => {
    expect(piFrameToServerMessages({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "t1", toolName: "bash" } }))
      .toEqual([{ type: "tool_result", toolUseId: "t1", content: "", toolName: "bash" }]);
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

  it("maps lifecycle frames to canonical status states", () => {
    expect(piFrameToServerMessages({ type: "agent_start" })).toEqual([{ type: "status", status: "running" }]);
    expect(piFrameToServerMessages({ type: "agent_settled" })).toEqual([{ type: "status", status: "idle" }]);
    expect(piFrameToServerMessages({ type: "agent_end" })).toEqual([{ type: "status", status: "idle" }]);
    expect(piFrameToServerMessages({ type: "engine_exit" })).toEqual([{ type: "status", status: "idle" }]);
  });

  it("maps bash_execution_update delta to canonical tool_result", () => {
    expect(piFrameToServerMessages({ type: "bash_execution_update", toolUseId: "bash-1", delta: "+ ls" }))
      .toEqual([{ type: "tool_result", toolUseId: "bash-1", content: "+ ls", toolName: "bash" }]);
  });

  it("maps tool_execution frames to canonical tool_result", () => {
    expect(piFrameToServerMessages({ type: "tool_execution_start", id: "x1", toolName: "write" }))
      .toEqual([{ type: "tool_result", toolUseId: "x1", content: "", toolName: "write" }]);
    expect(piFrameToServerMessages({ type: "tool_execution_end", id: "x1", toolName: "write", output: "ok" }))
      .toEqual([{ type: "tool_result", toolUseId: "x1", content: "ok", toolName: "write" }]);
  });

  it("returns [] for unknown/no-delta frames", () => {
    expect(piFrameToServerMessages({ type: "message_update", usage: {} })).toEqual([]);
    expect(piFrameToServerMessages({ type: "something_else" })).toEqual([]);
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

  it("maps stop_session/start/list_sessions to controls, unknown to none", () => {
    expect(inboundToActions({ type: "stop_session" })).toEqual([{ kind: "control", op: "abort" }]);
    expect(inboundToActions({ type: "start" })).toEqual([{ kind: "control", op: "get_state" }]);
    expect(inboundToActions({ type: "list_sessions" })).toEqual([{ kind: "control", op: "get_state" }]);
    expect(inboundToActions({ type: "bogus" as never })).toEqual([]);
  });

  it("compiles a PiFrame literal", () => {
    const f: PiFrame = { type: "agent_start" };
    expect(piFrameToServerMessages(f).length).toBe(1);
  });
});