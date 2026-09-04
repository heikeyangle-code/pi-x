import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEnginePath } from "./test-utils.js";
import { EngineProcess } from "./engine-process.js";

const slow = 10_000;

function workDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("EngineProcess", () => {
  it("spawns fake engine, correlates request/response, streams events", async () => {
    const piEntry = fakeEnginePath();
    const engine = new EngineProcess();
    const events: unknown[] = [];
    engine.onEvent = (ev) => events.push(ev);
    await engine.start({ piEntry, cwd: workDir("ep") });

    expect(engine.running).toBe(true);

    const resp = await engine.request({ type: "get_state" });
    expect(resp).toMatchObject({ type: "response", command: "get_state", success: true });
    expect(resp).toHaveProperty("id", expect.any(String));

    // prompt first streams a message_update event, then the correlated response.
    await engine.request({ type: "prompt", message: "hi" });
    await waitFor(() => events.length > 0);
    expect(events[0]).toMatchObject({ type: "message_update" });
    expect((events[0] as Record<string, unknown>)["assistantMessageEvent"]).toMatchObject({
      type: "text_delta",
    });

    await engine.stop();
    expect(engine.running).toBe(false);
  }, slow);

  it("routes extension_ui_request to onUiRequest with a working respond()", async () => {
    const piEntry = fakeEnginePath();
    const engine = new EngineProcess();
    let request: unknown;
    let respondRef: ((v: unknown) => void) | undefined;
    engine.onUiRequest = (req, respond) => {
      request = req;
      respondRef = respond;
    };
    await engine.start({ piEntry, cwd: workDir("ep-ui") });

    // ui_sensor makes the fake engine emit an extension_ui_request.
    void engine.request({ type: "ui_sensor" });
    await waitFor(() => respondRef !== undefined);

    expect(request).toMatchObject({ type: "extension_ui_request", id: "u-1", method: "confirm" });
    if (respondRef) respondRef({ confirmed: true });
    await engine.stop();
  }, slow);

  it("resolves in-flight requests as failure when the child exits", async () => {
    const piEntry = fakeEnginePath();
    const engine = new EngineProcess();
    await engine.start({ piEntry, cwd: workDir("ep-exit") });
    const p = engine.request({ type: "get_state" });
    await engine.stop();
    const resp = await p;
    expect(resp.success).toBe(false);
  }, slow);

  it("returns engine_not_running when no child is up", async () => {
    const engine = new EngineProcess();
    const resp = await engine.request({ type: "get_state" });
    expect(resp).toMatchObject({ success: false, error: "engine_not_running" });
  });
});