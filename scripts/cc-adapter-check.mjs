import assert from "node:assert/strict";
import { piFrameToServerMessages, inboundToActions } from "../packages/bridge/dist/pi-host/cc-adapter.js";

let m = piFrameToServerMessages({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } });
assert.equal(m[0].type, "stream_delta");
assert.equal(m[0].delta, "Hello");

m = piFrameToServerMessages({ type: "extension_ui_request", id: "u1", method: "confirm", title: "T", message: "M" });
assert.equal(m[0].type, "permission_request");
assert.equal(m[0].id, "u1");

m = piFrameToServerMessages({ type: "agent_start" });
assert.deepEqual(m, [{ type: "status", state: "running" }]);

const acts = inboundToActions({ type: "approve", toolUseId: "u1" });
assert.equal(acts[0].kind, "ui_response");
assert.deepEqual(acts[0].value, { confirmed: true });

const acts2 = inboundToActions({ type: "input", text: "/skill:web" });
assert.equal(acts2[0].payload.message, "/skill:web");

console.log("CC_ADAPTER_OK: all assertions passed");
