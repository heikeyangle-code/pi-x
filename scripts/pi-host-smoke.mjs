// Pi Host engine smoke — runs on CI (ubuntu) with a real pi install.
// Validates: engine bundle boots, EngineProcess JSONL round-trip works.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = join(tmpdir(), "pi-host-smoke");
mkdirSync(work, { recursive: true });
execSync("npm init -y && npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.85.0", {
  cwd: work,
  stdio: "inherit",
});

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
const resp = await engine.request({ type: "get_state" });
console.log("ENGINE_SMOKE response:", JSON.stringify(resp).slice(0, 200));
if (resp.success !== true) {
  throw new Error("engine smoke failed");
}
await engine.stop();
console.log("ENGINE_SMOKE_OK");
