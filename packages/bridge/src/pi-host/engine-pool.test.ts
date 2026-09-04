import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeEnginePath } from "./test-utils.js";
import { EnginePool, DEFAULT_ENGINE_MAX_IDLE_MS } from "./engine-pool.js";

const slow = 15_000;

function workDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("EnginePool", () => {
  it("reuses one engine process per project id", async () => {
    const pool = new EnginePool({ piEntry: fakeEnginePath() });
    const cwd = workDir("pool-reuse");
    const a = await pool.getOrStart("p1", cwd);
    const b = await pool.getOrStart("p1", cwd);
    expect(a).toBe(b);
    const r1 = await a.request({ type: "get_state" });
    expect(r1.success).toBe(true);
    await pool.stopAll();
  }, slow);

  it("spawns a separate engine per project cwd", async () => {
    const pool = new EnginePool({ piEntry: fakeEnginePath() });
    const a = await pool.getOrStart("p1", workDir("pool-d1"));
    const b = await pool.getOrStart("p2", workDir("pool-d2"));
    expect(a).not.toBe(b);
    await pool.stopAll();
  }, slow);

  it("REGRESSION: maxIdleMs:undefined must NOT reap a freshly-spawned engine (STATUS #1)", async () => {
    // PiGateway passes `maxIdleMs: opts.maxIdleMs` (undefined) — this used to
    // overwrite the 10-min default via object spread, making setTimeout(fn,
    // undefined) fire ~immediately and SIGTERM the engine right after the boot
    // guard. It must now fall back to the default and stay alive.
    const pool = new EnginePool({ piEntry: fakeEnginePath(), maxIdleMs: undefined });
    const cwd = workDir("pool-regr");
    const engine = await pool.getOrStart("p1", cwd);
    expect(engine.running).toBe(true);
    // engine stays alive well past the old immediate-reap window
    await sleep(800);
    expect(engine.running).toBe(true);
    const r = await engine.request({ type: "get_state" });
    expect(r.success).toBe(true);
    expect(pool.isRunning("p1")).toBe(true);
    await pool.stopAll();
  }, slow);

  it("reaps an idle engine after a short maxIdleMs", async () => {
    const pool = new EnginePool({ piEntry: fakeEnginePath(), maxIdleMs: 120 });
    const cwd = workDir("pool-idle");
    const engine = await pool.getOrStart("p1", cwd);
    expect(engine.running).toBe(true);
    await sleep(500); // > maxIdleMs (no activity)
    // The reaper stops it; onExit clears the slot.
    await sleep(50);
    expect(pool.isRunning("p1")).toBe(false);
    await pool.stopAll();
  }, slow);

  it("does not reap while the engine is actively used inside the window", async () => {
    const pool = new EnginePool({ piEntry: fakeEnginePath(), maxIdleMs: 600 });
    const cwd = workDir("pool-active");
    const e1 = await pool.getOrStart("p1", cwd); // touch resets the reaper
    await e1.request({ type: "get_state" });
    await sleep(300);
    const e2 = await pool.getOrStart("p1", cwd); // activity: re-touch, same engine
    expect(e2).toBe(e1);
    await e2.request({ type: "get_state" });
    await sleep(300);
    expect(pool.isRunning("p1")).toBe(true);
    await pool.stopAll();
  }, slow);

  it("boot-guard retries when the engine dies immediately (bad entry)", async () => {
    // Point at a nonexistent JS entry: spawn succeeds, process exits fast.
    const pool = new EnginePool({ piEntry: "/nonexistent/fake-engine.mjs" });
    const engine = await pool.getOrStart("p1", workDir("pool-guard"));
    // After bounded retries the pool exposes the engine (which is not running).
    expect(engine.running).toBe(false);
    const r = await engine.request({ type: "get_state" });
    expect(r.success).toBe(false);
    await pool.stopAll();
  }, slow);

  it("exposes DEFAULT_ENGINE_MAX_IDLE_MS", () => {
    expect(DEFAULT_ENGINE_MAX_IDLE_MS).toBe(10 * 60_000);
  });
});