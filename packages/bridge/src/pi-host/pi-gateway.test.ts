import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEnginePath } from "./test-utils.js";
import { PiGateway, PI_WIRE_PROTOCOL_VERSION } from "./pi-gateway.js";

const slow = 15_000;

function workDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function makeGateway(piEntry: string) {
  const cwd = workDir("gw");
  const gateway = new PiGateway({ piEntry, engineVersion: "0.0.0-test", resolveCwd: () => cwd });
  const envelopes: unknown[] = [];
  gateway.send = (env) => envelopes.push(env);
  return { gateway, envelopes, cwd };
}

describe("PiGateway", () => {
  it("returns control responses directly and wraps events in a versioned envelope", async () => {
    const { gateway, envelopes } = makeGateway(fakeEnginePath());
    const resp = await gateway.handleControl({
      id: "c1",
      type: "control",
      op: "get_state",
      projectId: "proj",
    });
    expect(resp).toMatchObject({ success: true, command: "get_state" });

    // prompt streams events through send() — those carry the envelope.
    await gateway.handleControl({ id: "c2", type: "control", op: "prompt", projectId: "proj", payload: { message: "hi" } });
    const msgEnv = envelopes.find(
      (e) => (e as { frame: { type?: string } })["frame"]?.["type"] === "message_update",
    );
    expect(msgEnv).toBeDefined();
    const env = msgEnv as Record<string, unknown>;
    expect(env["kind"]).toBe("pi");
    expect(env["engineVersion"]).toBe("0.0.0-test");
    expect(env["protocolVersion"]).toBe(PI_WIRE_PROTOCOL_VERSION);
    expect((env["frame"] as Record<string, unknown>)["projectId"]).toBe("proj");
    await gateway.stopAll();
  }, slow);

  it("streams engine events (prompt -> message_update) through send()", async () => {
    const { gateway, envelopes } = makeGateway(fakeEnginePath());
    await gateway.handleControl({ id: "c1", type: "control", op: "prompt", projectId: "proj", payload: { message: "hi" } });
    const envs = envelopes.filter((e) => (e as Record<string, unknown>)["frame"] && (e as { frame: { type?: string } })["frame"]["type"] === "message_update");
    expect(envs.length).toBeGreaterThan(0);
    await gateway.stopAll();
  }, slow);

  it("registers extension_ui_request and resolve via respondUi", async () => {
    const { gateway, envelopes } = makeGateway(fakeEnginePath());
    // prompt makes the fake engine emit an extension_ui_request.
    await gateway.handleControl({ id: "c1", type: "control", op: "prompt", projectId: "proj", payload: { message: "hi" } });

    let uiEnvelope: Record<string, unknown> | undefined;
    const start = Date.now();
    while (!uiEnvelope && Date.now() - start < 4000) {
      uiEnvelope = envelopes.find(
        (e) => (e as { frame: { type?: string } })["frame"]?.["type"] === "extension_ui_request",
      ) as Record<string, unknown>;
      if (!uiEnvelope) await new Promise((r) => setTimeout(r, 30));
    }
    expect(uiEnvelope).toBeDefined();
    const id = (uiEnvelope as unknown as { frame: { id: string } }).frame.id;
    const ok = gateway.respondUi(id, { confirmed: true });
    expect(ok).toBe(true);
    // responding twice for the same id must fail (already resolved)
    expect(gateway.respondUi(id, { confirmed: true })).toBe(false);
    await gateway.stopAll();
  }, slow);

  it("returns a typed failure for unsupported ops", async () => {
    const { gateway } = makeGateway(fakeEnginePath());
    const bad = await gateway.handleControl({ id: "c1", type: "control", op: "no_such_op", projectId: "proj" });
    expect(bad).toMatchObject({ success: false });
    expect((bad as { error: string }).error).toContain("unsupported_op");
    await gateway.stopAll();
  }, slow);

  it("routes the FULL pi RPC control surface to the engine", async () => {
    const { gateway } = makeGateway(fakeEnginePath());
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });
    // correlated success response (no unsupported_op, no throw).
    const cases: Array<[string, Record<string, unknown>]> = [
      ["prompt", { message: "hi" }],
      ["steer", { message: "hi" }],
      ["follow_up", { message: "hi" }],
      ["abort", {}],
      ["clear_queue", {}],
      ["new_session", { parentSession: "/s/1.jsonl" }],
      ["get_state", {}],
      ["get_messages", {}],
      ["set_model", { provider: "anthropic", modelId: "claude-x" }],
      ["cycle_model", {}],
      ["get_available_models", {}],
      ["set_thinking_level", { level: "high" }],
      ["cycle_thinking_level", {}],
      ["get_available_thinking_levels", {}],
      ["set_steering_mode", { mode: "all" }],
      ["set_follow_up_mode", { mode: "all" }],
      ["compact", { customInstructions: "keep it short" }],
      ["set_auto_compaction", { enabled: true }],
      ["set_auto_retry", { enabled: true }],
      ["abort_retry", {}],
      ["get_session_stats", {}],
      ["export_html", { outputPath: "/tmp/x.html" }],
      ["switch_session", { sessionPath: "/s/2.jsonl" }],
      ["fork", { sessionPath: "/s/1.jsonl" }],
      ["clone", {}],
      ["get_fork_messages", {}],
      ["get_entries", { since: "0" }],
      ["get_tree", {}],
      ["get_last_assistant_text", {}],
      ["set_session_name", { name: "demo" }],
      ["get_commands", {}],
      ["bash", { command: "echo hi" }],
      ["abort_bash", {}],
      ["get_settings", {}],
      ["get_models", {}],
      ["list_skills", {}],
      ["list_extensions", {}],
      ["looks_like_skill", { content: "---\ndescription: x\n---\n" }],
    ];
    for (const [op, payload] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const r = await ctl(op, payload);
      expect(r).toMatchObject({ success: true });
    }
    const stopped = await ctl("stop");
    expect(stopped).toMatchObject({ stopped: true });
    await gateway.stopAll();
  }, slow);

  it("round-trips pi surface files (settings/models) against an isolated piHome", async () => {
    const cwd = workDir("gw-surface");
    // Default piHome would read the host ~/.pi; isolate it to a tmp tree.
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome: workDir("gw-pihome"),
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    // empty by default
    const settings0 = await ctl("get_settings");
    expect(settings0).toMatchObject({ success: true });

    // update persists, then re-reads
    const up = await ctl("update_settings", { patch: { approvalPolicy: "on-failure", theme: "dark" } });
    expect(up.success).toBe(true);
    const settings1 = await ctl("get_settings");
    expect((settings1 as { data: Record<string, unknown> }).data).toMatchObject({
      approvalPolicy: "on-failure",
      theme: "dark",
    });

    // custom provider upsert -> get_models sees it
    const ups = await ctl("upsert_model", {
      providerId: "local",
      spec: { api: "anthropic-messages", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "m1" }] },
    });
    expect(ups.success).toBe(true);
    const models = await ctl("get_models");
    const providers = (models as { data: Record<string, unknown> }).data;
    expect(providers).toHaveProperty("local");

    // remove -> gone
    const rm = await ctl("remove_model", { providerId: "local" });
    expect(rm.success).toBe(true);
    const after = await ctl("get_models");
    expect((after as { data: Record<string, unknown> }).data).not.toHaveProperty("local");

    // skills dir lists empty (no .pi installed) — must not throw
    const skills = await ctl("list_skills");
    expect(skills).toMatchObject({ success: true });
    await gateway.stopAll();
  }, slow);
});