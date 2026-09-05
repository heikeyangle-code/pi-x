/**
 * Bridge Server doctor command — pi-only.
 *
 * Checks the health of the local pi runtime and provides actionable guidance
 * when issues are found — similar to `flutter doctor`. The claude/codex CLI,
 * Tailscale, Firebase push, Keychain and desktop host-service checks were
 * removed when the bridge became a purely local pi shell.
 */

import { execSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export type CheckCategory = "required" | "optional";

export interface CheckDefinition {
  name: string;
  category: CheckCategory;
  run: () => Promise<CheckResult>;
}

/** Sub-result for the pi engine (the only provider). */
export interface ProviderResult {
  name: string;
  installed: boolean;
  version?: string;
  authenticated: boolean;
  authMessage?: string;
  remediation?: string;
}

export interface DoctorReport {
  results: Array<CheckResult & { category: CheckCategory; providers?: ProviderResult[] }>;
  allRequiredPassed: boolean;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function execQuiet(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.version; // e.g. "v22.5.0"
  const [major, minor, patch] = version
    .slice(1)
    .split(".")
    .map((part) => parseInt(part, 10));
  const supported =
    major > 20 ||
    (major === 20 &&
      (minor > 18 || (minor === 18 && patch >= 1)));
  if (supported) {
    return { name: "Node.js", status: "pass", message: version };
  }
  return {
    name: "Node.js",
    status: "fail",
    message: `${version} (requires >=20.18.1)`,
    remediation: "Install Node.js >=20.18.1: https://nodejs.org/",
  };
}

export async function checkGit(): Promise<CheckResult> {
  try {
    const out = execQuiet("git --version"); // "git version 2.44.0"
    const version = out.replace("git version ", "");
    return { name: "Git", status: "pass", message: `v${version}` };
  } catch {
    return {
      name: "Git",
      status: "fail",
      message: "Not installed",
      remediation: "Install Git: https://git-scm.com/downloads",
    };
  }
}

/**
 * Check the pi engine entry (PI_ENGINE_ENTRY). pi is the only engine, so
 * this replaces the old claude/codex CLI provider checks.
 */
export async function checkPiEngine(): Promise<
  CheckResult & { providers: ProviderResult[] }
> {
  const piEntry = process.env.PI_ENGINE_ENTRY;
  const piHome = process.env.PI_HOME ?? homedir();

  let installed = false;
  let version: string | undefined;
  let authenticated = false;
  let authMessage: string | undefined;
  let remediation: string | undefined;

  if (!piEntry) {
    remediation =
      "Set PI_ENGINE_ENTRY to the absolute path of the pi CLI (e.g. <engine>/node_modules/.bin/pi)";
  } else {
    try {
      const out = execQuiet(`"${piEntry}" --version`);
      installed = true;
      version = out.trim().split("\n")[0];
      const authFile = join(piHome, ".pi", "agent", "auth.json");
      authenticated = existsSync(authFile);
      if (authenticated) {
        authMessage = "Credentials found (~/.pi/agent/auth.json)";
      } else {
        authMessage = "No credentials yet — log in via /login in the pi engine";
        remediation =
          "Run /login in the app chat or set provider credentials in Pi engine settings";
      }
    } catch {
      remediation = `pi CLI is not runnable at ${piEntry} — install the pi engine (see docs/ENGINE-BUNDLE.md)`;
    }
  }

  const providers: ProviderResult[] = [
    {
      name: "Pi engine",
      installed,
      version,
      authenticated,
      authMessage,
      remediation,
    },
  ];

  if (!installed) {
    return {
      name: "Pi engine",
      status: "fail",
      message: "pi engine not available",
      remediation,
      providers,
    };
  }
  return {
    name: "Pi engine",
    status: authenticated ? "pass" : "warn",
    message: version ?? "installed",
    ...(remediation ? { remediation } : {}),
    providers,
  };
}

export async function checkDependencies(): Promise<CheckResult> {
  // In monorepo setups, node_modules may be hoisted to the workspace root.
  // Use import.meta.resolve() to check if packages are resolvable.
  const requiredPackages = ["ws"];
  const missing: string[] = [];

  for (const pkg of requiredPackages) {
    try {
      import.meta.resolve(pkg);
    } catch {
      missing.push(pkg);
    }
  }

  if (missing.length > 0) {
    return {
      name: "npm dependencies",
      status: "fail",
      message: `Missing: ${missing.join(", ")}`,
      remediation: "Run: npm install",
    };
  }

  return { name: "npm dependencies", status: "pass", message: "All packages available" };
}

export async function checkPortAvailable(port: number): Promise<CheckResult> {
  if (port === 0) {
    return {
      name: "Port availability",
      status: "pass",
      message: "An available ephemeral port can be allocated",
    };
  }

  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      done({
        name: "Port availability",
        status: "warn",
        message: `Port ${port} check timed out`,
      });
    }, 3000);

    const done = (result: CheckResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        done({
          name: "Port availability",
          status: "warn",
          message: `Port ${port} is in use`,
          remediation: `Another Bridge may be running, or set BRIDGE_PORT to a different port`,
        });
      } else {
        done({
          name: "Port availability",
          status: "warn",
          message: `Port ${port} check failed: ${err.code}`,
        });
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        done({
          name: "Port availability",
          status: "pass",
          message: `Port ${port} is available`,
        });
      });
    });
  });
}

export async function checkDataDirectory(): Promise<CheckResult> {
  const dir = join(homedir(), ".ccpocket");
  if (!existsSync(dir)) {
    return {
      name: "Data directory",
      status: "pass",
      message: "~/.ccpocket/ will be created on first run",
    };
  }
  try {
    accessSync(dir, fsConstants.R_OK | fsConstants.W_OK);
    return {
      name: "Data directory",
      status: "pass",
      message: "~/.ccpocket/ exists",
    };
  } catch {
    return {
      name: "Data directory",
      status: "warn",
      message: "~/.ccpocket/ is not writable",
      remediation: "Fix permissions: chmod u+rw ~/.ccpocket",
    };
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function getAllChecks(): CheckDefinition[] {
  const port = parseInt(process.env.BRIDGE_PORT ?? "8765", 10);

  return [
    // Required
    { name: "Node.js", category: "required", run: checkNodeVersion },
    { name: "Git", category: "required", run: checkGit },
    { name: "Pi engine", category: "required", run: checkPiEngine },
    { name: "npm dependencies", category: "required", run: checkDependencies },
    {
      name: "Port availability",
      category: "required",
      run: () => checkPortAvailable(port),
    },
    // Optional
    { name: "Data directory", category: "optional", run: checkDataDirectory },
  ];
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks = getAllChecks();
  const results: DoctorReport["results"] = [];

  for (const check of checks) {
    const result = await check.run();
    results.push({ ...result, category: check.category });
  }

  const allRequiredPassed = results
    .filter((r) => r.category === "required")
    .every((r) => r.status === "pass" || r.status === "warn");

  return { results, allRequiredPassed };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const SYMBOLS_TTY = {
  pass: "\x1b[32m✓\x1b[0m",
  fail: "\x1b[31m✗\x1b[0m",
  warn: "\x1b[33m!\x1b[0m",
  skip: "\x1b[90m-\x1b[0m",
} as const;

const SYMBOLS_PLAIN = {
  pass: "[OK]",
  fail: "[FAIL]",
  warn: "[WARN]",
  skip: "[SKIP]",
} as const;

function providerStatusIcon(
  p: ProviderResult,
  sym: typeof SYMBOLS_TTY | typeof SYMBOLS_PLAIN,
): string {
  if (!p.installed) return sym.skip;
  if (!p.authenticated) return sym.warn;
  return sym.pass;
}

function providerStatusMessage(p: ProviderResult): string {
  if (!p.installed) return "Not installed";
  const parts: string[] = [];
  if (p.version) parts.push(p.version);
  if (p.authenticated) {
    parts.push(p.authMessage ? `(${p.authMessage})` : "(authenticated)");
  } else if (p.authMessage) {
    parts.push(`(${p.authMessage})`);
  }
  return parts.join(" ") || "Installed";
}

export function printReport(report: DoctorReport): void {
  const isTTY = process.stdout.isTTY ?? false;
  const sym = isTTY ? SYMBOLS_TTY : SYMBOLS_PLAIN;
  const NAME_WIDTH = 22;

  console.log("");
  console.log("ccpocket-bridge doctor");
  console.log("======================");

  // Required checks
  const required = report.results.filter((r) => r.category === "required");
  if (required.length > 0) {
    console.log("");
    console.log("Required:");
    for (const r of required) {
      const icon = sym[r.status];
      const nameCol = r.name.padEnd(NAME_WIDTH);
      console.log(`  ${icon} ${nameCol} ${r.message}`);

      // Print provider sub-items for the pi engine check
      if (r.providers) {
        for (const p of r.providers) {
          const pIcon = providerStatusIcon(p, sym);
          const pName = p.name.padEnd(NAME_WIDTH);
          console.log(`      ${pIcon} ${pName} ${providerStatusMessage(p)}`);
          if (p.remediation) {
            console.log(`          → ${p.remediation}`);
          }
        }
      } else if (r.remediation && (r.status === "fail" || r.status === "warn")) {
        console.log(`      → ${r.remediation}`);
      }
    }
  }

  // Optional checks
  const optional = report.results.filter((r) => r.category === "optional");
  if (optional.length > 0) {
    console.log("");
    console.log("Optional:");
    for (const r of optional) {
      const icon = sym[r.status];
      const nameCol = r.name.padEnd(NAME_WIDTH);
      console.log(`  ${icon} ${nameCol} ${r.message}`);
      if (r.remediation && (r.status === "fail" || r.status === "warn" || r.status === "skip")) {
        console.log(`      → ${r.remediation}`);
      }
    }
  }

  // Summary
  console.log("");
  const failCount = report.results.filter((r) => r.status === "fail").length;
  const warnCount = report.results.filter((r) => r.status === "warn").length;

  if (report.allRequiredPassed) {
    const msg = "All required checks passed.";
    console.log(isTTY ? `\x1b[32m${msg}\x1b[0m` : msg);
  } else {
    const msg = `${failCount} required check(s) failed.`;
    console.log(isTTY ? `\x1b[31m${msg}\x1b[0m` : msg);
  }

  if (warnCount > 0) {
    console.log(`${warnCount} warning(s).`);
  }

  console.log("");
}
