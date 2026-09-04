import { describe, it, expect } from "vitest";
import { piFrameToServerMessages, inboundToActions, type PiFrame } from "./cc-adapter.js";

describe("cc-adapter piFrameToServerMessages", () => {
  it("maps text_delta to stream_delta(text)", () => {
    const out = piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" } });
    expect(out).toEqual([{ type: "stream_delta", delta: "Hi", kind: "text", contentIndex: 0, usage: {} }]);
  });

  it("maps thinking_delta to stream_delta(thinking)", () => {
    const out = piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "reason" } });
    expect(out).toEqual([{ type: "stream_delta", delta: "reason", kind: "thinking", contentIndex: 1, usage: {} }]);
  });

  it("maps text_start/text_end to assistant partial/final", () => {
    expect(piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } }))
      .toEqual([{ type: "assistant", role: "assistant", partial: true }]);
    expect(piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "done" } }))
      .toEqual([{ type: "assistant", role: "assistant", content: "done" }]);
  });

  it("maps toolcall_start/end to tool_result running/done", () => {
    expect(piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_start", id: "t1", toolName: "bash" } }))
      .toEqual([{ type: "tool_result", toolName: "bash", id: "t1", status: "running" }]);
    expect(piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_end", id: "t1", toolCall: { id: "t1", name: "bash", input: { cmd: "ls" } } } }))
      .toEqual([{ type: "tool_result", toolName: "bash", id: "t1", status: "done", input: { cmd: "ls" } }]);
  });

  it("maps extension_ui_request(confirm) to permission_request card", () => {
    const out = piFrameToServerMessages({ type: "extension_ui_request", id: "u1", method: "confirm", title: "T", message: "M", options: ["a", "b"] });
    expect(out).toEqual([{ type: "permission_request", id: "u1", method: "confirm", title: "T", message: "M", options: ["a", "b"] }]);
  });

  it("maps lifecycle frames to status states", () => {
    expect(piFrameToServerMessages({ type: "agent_start" })).toEqual([{ type: "status", state: "running" }]);
    expect(piFrameToServerMessages({ type: "agent_settled" })).toEqual([{ type: "status", state: "idle" }]);
    expect(piFrameToServerMessages({ type: "agent_end" })).toEqual([{ type: "status", state: "idle" }]);
    expect(piFrameToServerMessages({ type: "engine_exit" })).toEqual([{ type: "status", state: "idle", engineExited: true }]);
  });

  it("maps bash_execution_update delta to tool_result outputDelta", () => {
    expect(piFrameToServerMessages({ type: "bash_execution_update", delta: "+ ls" }))
      .toEqual([{ type: "tool_result", status: "running", outputDelta: "+ ls" }]);
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