import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

  it("lists skills across global+project scopes with SKILL.md descriptions and reads them back", async () => {
    const cwd = workDir("gw-skills");
    const piHome = workDir("gw-pihome-skills");
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome,
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    // global skill with frontmatter description + a bare project skill
    await mkdir(join(piHome, ".pi", "agent", "skills", "code-review"), { recursive: true });
    await writeFile(
      join(piHome, ".pi", "agent", "skills", "code-review", "SKILL.md"),
      "---\ndescription: Run a thorough code review\n---\n# Code review\nSteps...\n",
    );
    await mkdir(join(cwd, ".pi", "skills", "docs"), { recursive: true });
    await writeFile(join(cwd, ".pi", "skills", "docs", "SKILL.md"), "no frontmatter here\n");

    const listed = await ctl("list_skills");
    expect(listed).toMatchObject({ success: true });
    const entries = (listed as { data: Array<Record<string, unknown>> }).data;
    expect(entries).toEqual([
      { name: "code-review", scope: "global", description: "Run a thorough code review" },
      { name: "docs", scope: "project", description: undefined },
    ]);

    // read_skill returns the markdown body for both scopes
    const global = await ctl("read_skill", { scope: "global", name: "code-review" });
    expect(global).toMatchObject({ success: true });
    expect(
      ((global as { data: { content: string } }).data.content as string).startsWith("---"),
    ).toBe(true);
    const project = await ctl("read_skill", { scope: "project", name: "docs" });
    expect((project as { data: { content: string } }).data.content).toBe("no frontmatter here\n");

    // missing skill -> content null, traversal names rejected
    const missing = await ctl("read_skill", { scope: "global", name: "nope" });
    expect((missing as { data: { content: unknown } }).data.content).toBeNull();
    const bad = await ctl("read_skill", { scope: "global", name: "../settings.json" });
    expect(bad).toMatchObject({ success: false });
    await gateway.stopAll();
  }, slow);

  it("restart_engine stops the running engine and next request respawns it", async () => {
    const { gateway } = makeGateway(fakeEnginePath());
    const first = await gateway.handleControl({ id: "c1", type: "control", op: "get_state", projectId: "proj" });
    expect(first).toMatchObject({ success: true });

    const restarted = await gateway.handleControl({ id: "c2", type: "control", op: "restart_engine", projectId: "proj" });
    expect(restarted).toMatchObject({ success: true, restarted: true });

    // engine was stopped; next request must respawn it and still round-trip
    const after = await gateway.handleControl({ id: "c3", type: "control", op: "get_state", projectId: "proj" });
    expect(after).toMatchObject({ success: true });
    await gateway.stopAll();
  }, slow);

  it("round-trips pix-config (engine launch args) against an isolated piHome", async () => {
    const cwd = workDir("gw-pix");
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome: workDir("gw-pihome-pix"),
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    // empty by default
    const empty = await ctl("get_pix_config");
    expect(empty).toMatchObject({ success: true });
    expect((empty as { data: { engineArgs?: string[] } }).data.engineArgs).toBeUndefined();

    // update persists (filters empty strings), re-reads
    const up = await ctl("update_pix_config", { patch: { engineArgs: ["--no-context-files", "", "--no-skills"] } });
    expect(up.success).toBe(true);
    expect((up as { data: { engineArgs: string[] } }).data.engineArgs).toEqual(["--no-context-files", "--no-skills"]);
    const read = await ctl("get_pix_config");
    expect((read as { data: { engineArgs: string[] } }).data.engineArgs).toEqual(["--no-context-files", "--no-skills"]);

    // engine still round-trips with args configured (args only affect spawn)
    const st = await ctl("get_state");
    expect(st).toMatchObject({ success: true });
    await gateway.stopAll();
  }, slow);

  it("reads and writes system prompt files (global + project scope)", async () => {
    const cwd = workDir("gw-prompt");
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome: workDir("gw-pihome-prompt"),
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    // empty by default (no files yet)
    const before = await ctl("read_prompt_files");
    const beforeData = (before as { data: { global: Record<string, unknown>; project: Record<string, unknown> } }).data;
    expect(beforeData.global.systemPrompt).toBeNull();
    expect(beforeData.global.appendSystemPrompt).toBeNull();
    expect(beforeData.project.systemPrompt).toBeNull();

    // write global SYSTEM.md
    const wg = await ctl("write_prompt_file", { scope: "global", kind: "system", content: "# System\nBe concise." });
    expect(wg.success).toBe(true);
    // write project APPEND_SYSTEM.md
    const wp = await ctl("write_prompt_file", { scope: "project", kind: "append", content: "## Rules\nNo emoji." });
    expect(wp.success).toBe(true);

    const after = await ctl("read_prompt_files");
    const afterData = (after as { data: { global: Record<string, string | null>; project: Record<string, string | null> } }).data;
    expect(afterData.global.systemPrompt).toContain("Be concise.");
    expect(afterData.global.appendSystemPrompt).toBeNull();
    expect(afterData.project.systemPrompt).toBeNull();
    expect(afterData.project.appendSystemPrompt).toContain("No emoji.");
    await gateway.stopAll();
  }, slow);

  it("lists extensions from project and global scopes (1:1 engine discovery)", async () => {
    const cwd = workDir("gw-ext");
    const piHome = workDir("gw-pihome-ext");
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome,
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    await mkdir(join(cwd, ".pi", "extensions", "local-ext"), { recursive: true });
    await mkdir(join(piHome, ".pi", "agent", "extensions", "global-ext"), { recursive: true });

    const listed = await ctl("list_extensions");
    const entries = (listed as { data: Array<{ name: string; scope: string }> }).data;
    expect(entries).toEqual([
      { name: "local-ext", scope: "project" },
      { name: "global-ext", scope: "global" },
    ]);
    await gateway.stopAll();
  }, slow);

  it("round-trips prompt templates (list/read/write/delete, official template semantics)", async () => {
    const cwd = workDir("gw-tpl");
    const piHome = workDir("gw-pihome-tpl");
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome,
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    // empty by default
    const empty = await ctl("list_prompt_templates");
    expect((empty as { data: unknown[] }).data).toEqual([]);

    // write a global template (name without .md is appended)
    const wg = await ctl("write_prompt_template", {
      scope: "global",
      name: "pr",
      content: '---\ndescription: "Open a PR"\nargument-hint: <branch>\n---\nBody',
    });
    expect(wg.success).toBe(true);

    // write a project template with frontmatter-less description fallback
    const wp = await ctl("write_prompt_template", {
      scope: "project",
      name: "fix-tests.md",
      content: "# Fix failing tests\n\nBody",
    });
    expect(wp.success).toBe(true);

    const listed = await ctl("list_prompt_templates");
    const templates = (listed as { data: Array<Record<string, unknown>> }).data;
    expect(templates).toEqual([
      {
        name: "pr",
        scope: "global",
        description: "Open a PR",
        argumentHint: "<branch>",
        path: join(piHome, ".pi", "agent", "prompts", "pr.md"),
      },
      {
        name: "fix-tests",
        scope: "project",
        description: "# Fix failing tests",
        argumentHint: undefined,
        path: join(cwd, ".pi", "prompts", "fix-tests.md"),
      },
    ]);

    // read back full content including frontmatter
    const read = await ctl("read_prompt_template", { scope: "project", name: "fix-tests" });
    expect((read as { data: { content: string } }).data.content).toContain("# Fix failing tests");
    const missing = await ctl("read_prompt_template", { scope: "global", name: "nope" });
    expect(missing).toMatchObject({ success: false });

    // traversal rejected
    const bad = await ctl("write_prompt_template", { scope: "global", name: "../evil", content: "x" });
    expect(bad).toMatchObject({ success: false });

    // delete -> gone
    const del = await ctl("delete_prompt_template", { scope: "project", name: "fix-tests" });
    expect((del as { data: { deleted: boolean } }).data.deleted).toBe(true);
    const after = await ctl("list_prompt_templates");
    expect(
      (after as { data: Array<Record<string, unknown>> }).data.map((t) => t["name"]),
    ).toEqual(["pr"]);
    await gateway.stopAll();
  }, slow);

  it("runtime route: defaults to bionic, persists set_runtime_route, rejects invalid", async () => {
    const cwd = workDir("gw-runtime");
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome: workDir("gw-pihome-runtime"),
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    // default: bionic, no host probe -> bionic-only availability
    const status0 = await ctl("get_runtime_status");
    const d0 = (status0 as { data: { route: string; available: string[] } }).data;
    expect(d0.route).toBe("bionic");
    expect(d0.available).toEqual(["bionic"]);

    // invalid route rejected
    const bad = await ctl("set_runtime_route", { route: "hack" });
    expect(bad).toMatchObject({ success: false, error: "invalid_runtime_route" });

    // switch to proroot persists and restarts the engine
    const sw = await ctl("set_runtime_route", { route: "proroot" });
    expect(sw).toMatchObject({ success: true, route: "proroot", restarted: true });
    const status1 = await ctl("get_runtime_status");
    expect((status1 as { data: { route: string } }).data.route).toBe("proroot");

    // engine still round-trips after route switch (next request respawns)
    const st = await ctl("get_state");
    expect(st).toMatchObject({ success: true });
    await gateway.stopAll();
  }, slow);

  it("runtime route: surfaces host probe status and runtime_install routing", async () => {
    const cwd = workDir("gw-runtime-host");
    const installed: string[] = [];
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome: workDir("gw-pihome-runtime-host"),
      resolveCwd: () => cwd,
      runtimeStatus: async () => ({
        route: "bionic",
        prorootInstalled: installed.includes("proroot"),
        prootDistroInstalled: installed.includes("proot-distro"),
        available: ["bionic", "proroot", "proot-distro"],
      }),
      runtimeInstall: async (route) => {
        if (route === "proroot" || route === "proot-distro") {
          installed.push(route);
          return { success: true };
        }
        return { success: false, error: "invalid_runtime_route" };
      },
    });
    gateway.send = () => undefined;
    const ctl = (op: string, payload: Record<string, unknown> = {}) =>
      gateway.handleControl({ id: "cX", type: "control", op, projectId: "proj", payload });

    const status0 = await ctl("get_runtime_status");
    const d0 = (status0 as { data: { prorootInstalled: boolean; available: string[] } }).data;
    expect(d0.prorootInstalled).toBe(false);
    expect(d0.available).toEqual(["bionic", "proroot", "proot-distro"]);

    // install via host hook
    const ins = await ctl("runtime_install", { route: "proroot" });
    expect(ins).toMatchObject({ success: true });
    const status1 = await ctl("get_runtime_status");
    expect((status1 as { data: { prorootInstalled: boolean } }).data.prorootInstalled).toBe(true);

    // bionic not installable; without host hook -> unavailable error
    const bad = await ctl("runtime_install", { route: "bionic" });
    expect(bad).toMatchObject({ success: false });
    await gateway.stopAll();
  }, slow);

  it("runtime route: runtime_install unavailable when no host hook is wired", async () => {
    const cwd = workDir("gw-runtime-noop");
    const gateway = new PiGateway({
      piEntry: fakeEnginePath(),
      engineVersion: "0.0.0-test",
      piHome: workDir("gw-pihome-runtime-noop"),
      resolveCwd: () => cwd,
    });
    gateway.send = () => undefined;
    const resp = await gateway.handleControl({
      id: "cX",
      type: "control",
      op: "runtime_install",
      projectId: "proj",
      payload: { route: "proroot" },
    });
    expect(resp).toMatchObject({ success: false, error: "runtime_install_unavailable" });
    await gateway.stopAll();
  }, slow);
});