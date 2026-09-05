import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

// The CLI is spawned from the package root so the "src/cli.ts" entry is
// resolved regardless of the directory vitest was started from.
const cliCwd = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function runCli(args: string[], bridgePort?: string) {
  const env = { ...process.env };
  if (bridgePort === undefined) {
    delete env.BRIDGE_PORT;
  } else {
    env.BRIDGE_PORT = bridgePort;
  }
  return spawnSync(process.execPath, [tsxCli, "src/cli.ts", ...args], {
    cwd: cliCwd,
    encoding: "utf8",
    env,
  });
}

describe("ccpocket-bridge CLI", () => {
  it("rejects an invalid --port value before server startup", () => {
    const result = runCli(["--port", "abc"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[bridge] Failed to start: Invalid BRIDGE_PORT "abc"',
    );
    expect(result.stdout).not.toContain("Starting ccpocket bridge server");
  });

  it("does not ignore an empty inline --port value", () => {
    const result = runCli(["--port="]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[bridge] Failed to start: Invalid BRIDGE_PORT ""',
    );
  });

  it("rejects --port when its value is missing", () => {
    const result = runCli(["--port"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[bridge] Failed to start: Invalid BRIDGE_PORT ""',
    );
  });

  it("rejects an invalid BRIDGE_PORT before server startup", () => {
    const result = runCli([], "8.5");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[bridge] Failed to start: Invalid BRIDGE_PORT "8.5"',
    );
    expect(result.stdout).not.toContain("Starting ccpocket bridge server");
  });
});
