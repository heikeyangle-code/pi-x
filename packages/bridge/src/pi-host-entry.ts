/**
 * Pi X — Android engine-host entry (no sharp / no ccpocket stores).
 *
 * The regular bridge entry (src/index.ts) pulls image/media stores and their
 * native deps (sharp) at module top level, which cannot build on Android.
 * This dedicated entry only wires the Pi Host transport:
 *
 *   PI_HOST=1 PI_ENGINE_ENTRY=<abs path to pi CLI> PI_ENGINE_VERSION=<ver> \
 *     BRIDGE_PORT=8765 node dist/pi-host-entry.js
 */

import { parsePort } from "./pi-host/server.js";
import { startPiHostServer } from "./pi-host/server.js";
import { createRuntimeHooks } from "./pi-host/runtime-manager.js";
import { dirname } from "node:path";

async function main(): Promise<void> {
  const piEntry = process.env.PI_ENGINE_ENTRY;
  if (!piEntry) {
    throw new Error(
      "PI_HOST=1 requires PI_ENGINE_ENTRY (absolute path to the pi CLI entry)",
    );
  }
  const engineVersion = process.env.PI_ENGINE_VERSION ?? "dev";
  const port = parsePort(process.env.BRIDGE_PORT, 8765);
  const piHome = process.env.PI_HOME ?? process.env.HOME ?? "";

  // Route B runtime hooks (docs/ENGINE-BUNDLE.md "路线切换 UI 落地"): spawn
  // prefix from the active route, truthful status probe, install orchestration.
  const runtime = createRuntimeHooks({
    piHome,
    enginesDir: dirname(piEntry),
  });

  const { stop } = await startPiHostServer({
    port,
    piEntry,
    engineVersion,
    resolveCwd: (projectId) => projectId,
    commandPrefix: (cwd) => runtime.resolveCommandPrefix(cwd),
    runtimeStatus: () => runtime.status(),
    runtimeInstall: (route, onProgress) => runtime.install(route, onProgress),
  });

  console.log(`[pi-host] Ready on ws://127.0.0.1:${port} (pi engine ${engineVersion})`);

  const shutdown = async (): Promise<void> => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[pi-host] fatal:", err);
  process.exit(1);
});
