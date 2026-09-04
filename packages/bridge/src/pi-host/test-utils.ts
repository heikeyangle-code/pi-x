/**
 * Test helper — a minimal pi-like JSONL engine for exercising EngineProcess /
 * EnginePool / PiGateway without downloading the real @earendil-works bundle.
 *
 * The fake engine reads newline-delimited JSON from stdin and writes JSON
 * frames to stdout, mirroring pi's `--mode rpc` framing:
 *   - `get_state` / `get_available_models` / `prompt` -> correlated response
 *   - `{type:"ui_sensor"}` -> emits an `extension_ui_request`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_BODY = `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (raw) => {
  let req; try { req = JSON.parse(raw); } catch { return; }
  const id = req.id;
  if (req.type === "get_state") {
    return process.stdout.write(JSON.stringify({ type: "response", command: "get_state", id, success: true, data: { messageCount: 3 } }) + "\\n");
  }
  if (req.type === "get_available_models") {
    return process.stdout.write(JSON.stringify({ type: "response", command: "get_available_models", id, success: true, data: { models: [] } }) + "\\n");
  }
  if (req.type === "prompt") {
    process.stdout.write(JSON.stringify({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "u-1", method: "confirm", title: "T", message: "M" }) + "\\n");
    return process.stdout.write(JSON.stringify({ type: "response", command: "prompt", id, success: true, data: {} }) + "\\n");
  }
  if (req.type === "ui_sensor") {
    return process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "u-1", method: "confirm", title: "T", message: "M" }) + "\\n");
  }
  if (req.type === "extension_ui_response") {
    // Echo back what the engine observed so tests can assert confirmed/cancelled
    // actually reached the extension (not dropped/undefined).
    return process.stdout.write(JSON.stringify({ type: "ui_response_seen", id: req.id, requestId: req.id, response: req }) + "\\n");
  }
  return process.stdout.write(JSON.stringify({ type: "response", command: req.type, id, success: true, data: {} }) + "\\n");
});`;

/** Write the fake engine to a fresh tmp dir and return its absolute path. */
export function fakeEnginePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-fake-engine-"));
  const path = join(dir, "fake-rpc-engine.mjs");
  writeFileSync(path, FAKE_BODY);
  return path;
}

export { FAKE_BODY as fakeEngineSource };