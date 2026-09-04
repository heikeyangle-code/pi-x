// Pi engine full RPC smoke — runs on CI (ubuntu) with a real pi install.
// Validates the engine surface the Pi Host relies on, beyond the basic
// get_state round-trip of pi-host-smoke.mjs: state / commands / models /
// thinking / session stats / entries / tree. Offline: no LLM calls involved.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "pi-rpc-smoke-"));
execSync(
  "npm init -y && npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.85.0",
  { cwd: work, stdio: "inherit" },
);

const piEntry = join(
  work,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

const { EngineProcess } = await import(
  new URL("../packages/bridge/dist/pi-host/engine-process.js", import.meta.url)
);

const engine = new EngineProcess();
await engine.start({ piEntry, cwd: work });

const checks = [
  ["get_state"],
  ["get_commands"],
  ["get_available_models"],
  ["get_available_thinking_levels"],
  ["get_session_stats"],
  ["get_entries"],
  ["get_tree"],
];

let failed = 0;
for (const [type] of checks) {
  const resp = await engine.request({ type });
  const ok = resp?.success === true;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${type} -> ${JSON.stringify(resp?.data ?? resp).slice(0, 120)}`);
}
await engine.stop();

if (failed > 0) {
  console.error(`RPC_SMOKE_FAILED: ${failed}/${checks.length} commands failed`);
  process.exit(1);
}
console.log(`RPC_SMOKE_OK (${checks.length}/${checks.length})`);
