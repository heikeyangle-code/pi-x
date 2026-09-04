#!/usr/bin/env node
// Engine bundle tooling — build / verify / manifest per docs/ENGINE-BUNDLE.md.
//
//   node scripts/engine-bundle.mjs build <version> [--out <dir>] [--changelog <url>] [--breaking <json>]
//   node scripts/engine-bundle.mjs verify <bundleDir>
//   node scripts/engine-bundle.mjs manifest <bundleDir> [--emit]
//
// Self-contained: the RPC smoke speaks raw JSONL to `pi --mode rpc` so it does
// not depend on the compiled bridge. Offline (PI_OFFLINE=1), no LLM calls.
//
// Output layout (per ENGINE-BUNDLE.md):
//   <out>/<version>/node_modules/...   installed engine (npm ci --ignore-scripts)
//   <out>/<version>/manifest.json      machine-readable bundle metadata
//   <out>/pi-engine-<version>.tgz      packed tarball of the bundle dir
//   <out>/SHA256SUMS                   checksum manifest for published tarballs

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const DEFAULT_REQUIRES_RUNTIME = ">=22.19.0";
export const DEFAULT_CHANGELOG = "https://pi.dev/docs/changelog";
export const DEFAULT_OUT = "engines";

export const BREAKING_EMPTY = { settings: [], sessionFormat: false, notes: "" };

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["build", "verify", "manifest"].includes(command)) {
    fail("usage: engine-bundle.mjs <build|verify|manifest> [args]");
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--out" || option === "--changelog" || option === "--breaking") {
      const value = rest[index + 1];
      if (value === undefined) fail(`missing value for ${option}`);
      options[option.slice(2)] = value;
      index += 1;
    } else if (option === "--emit") {
      options.emit = true;
    } else if (options.command === "verify" || options.command === "manifest") {
      // positional bundle dir for verify/manifest
      if (options.dir === undefined) options.dir = option;
      else fail(`unexpected argument: ${option}`);
    } else if (options.version === undefined) {
      options.version = option;
    } else {
      fail(`unexpected argument: ${option}`);
    }
  }

  if (options.command === "build" && options.version === undefined) {
    fail("build requires <version> (e.g. 0.85.0)");
  }
  if (options.command !== "build" && options.dir === undefined) {
    fail(`${options.command} requires <bundleDir>`);
  }
  if (options.breaking !== undefined) {
    try {
      options.breaking = JSON.parse(options.breaking);
    } catch {
      fail("--breaking must be valid JSON");
    }
  }
  return options;
}

export function isSemver(version) {
  return typeof version === "string" && SEMVER_RE.test(version);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 10 * 60_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "")
      .trim()
      .slice(-600);
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

export function piEntryOf(dir) {
  return join(
    dir,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
}

export function piVersion(piEntry) {
  const output = run(process.execPath, [piEntry, "--version"]).trim();
  const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
  if (!match) fail(`cannot parse pi version from output: ${output}`);
  return match[0];
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function normalizeManifest(input) {
  const manifest = {
    version: String(input?.version ?? ""),
    requiresRuntime: String(input?.requiresRuntime ?? DEFAULT_REQUIRES_RUNTIME),
    publishedAt: String(input?.publishedAt ?? ""),
    sha256: String(input?.sha256 ?? ""),
    changelog: String(input?.changelog ?? DEFAULT_CHANGELOG),
    breaking: input?.breaking ?? BREAKING_EMPTY,
    rpcSmoke: String(input?.rpcSmoke ?? ""),
  };
  return manifest;
}

export function validateManifest(manifest) {
  const errors = [];
  if (!isSemver(manifest.version)) errors.push(`invalid version: ${manifest.version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.publishedAt)) {
    errors.push(`invalid publishedAt: ${manifest.publishedAt}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(manifest.sha256)) {
    errors.push(`invalid sha256: ${manifest.sha256}`);
  }
  if (manifest.rpcSmoke !== "pass") errors.push(`rpcSmoke must be "pass"`);
  if (typeof manifest.breaking?.sessionFormat !== "boolean") {
    errors.push("breaking.sessionFormat must be boolean");
  }
  if (!Array.isArray(manifest.breaking?.settings)) {
    errors.push("breaking.settings must be an array");
  }
  return errors;
}

export function buildManifest({ version, publishedAt, sha256, changelog, breaking }) {
  const manifest = normalizeManifest({
    version,
    requiresRuntime: DEFAULT_REQUIRES_RUNTIME,
    publishedAt,
    sha256,
    changelog,
    breaking,
    rpcSmoke: "pass",
  });
  const errors = validateManifest(manifest);
  if (errors.length > 0) fail(`manifest invalid: ${errors.join("; ")}`);
  return manifest;
}

export function readManifest(dir) {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) fail(`manifest.json missing: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`manifest.json not valid JSON: ${error.message}`);
  }
  const manifest = normalizeManifest(parsed);
  const errors = validateManifest(manifest);
  if (errors.length > 0) fail(`manifest invalid: ${errors.join("; ")}`);
  return manifest;
}

export function writeManifest(dir, manifest) {
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Raw JSONL RPC smoke against `pi --mode rpc --no-session` (offline).
 * @param {string} piEntry path to dist/bundle/cli.js
 * @param {string} cwd working directory
 * @param {Array<[string, string]>} requests [id, type] pairs
 * @param {{timeoutMs?: number}} [options]
 */
export function rpcSmoke(piEntry, cwd, requests, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [piEntry, "--mode", "rpc", "--no-session"],
      {
        cwd,
        env: { ...process.env, PI_OFFLINE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`rpcSmoke timeout after ${timeoutMs}ms (${stderr || stdout || "no output"})`.slice(0, 600)));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const frames = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        });
      const results = requests.map(([id, type]) => {
        const frame = frames.find((frame) => frame && String(frame.id) === id);
        const ok = frame?.success === true;
        return { id, type, ok, summary: JSON.stringify(frame?.data ?? frame).slice(0, 140) };
      });
      if (results.every((result) => result.ok)) {
        resolve({ ok: true, results });
      } else {
        reject(
          new Error(
            `rpcSmoke failed (exit=${code}): ${JSON.stringify(results)} stderr=${stderr.slice(-400)}`,
          ),
        );
      }
    });
    for (const [id, type] of requests) {
      child.stdin.write(`${JSON.stringify({ type, id })}\n`);
    }
    child.stdin.end();
  });
}

export function packTarball(dir, version, out) {
  const tarball = resolve(out, `pi-engine-${version}.tgz`);
  mkdirSync(out, { recursive: true });
  run("tar", ["-czf", tarball, "."], { cwd: dir });
  return tarball;
}

export async function buildVersion(version, options = {}) {
  if (!isSemver(version)) fail(`invalid semver: ${version}`);
  const out = resolve(options.out ?? DEFAULT_OUT);
  const dir = resolve(out, version);
  mkdirSync(dir, { recursive: true });

  console.log(`BUILD install version=${version} dir=${dir}`);
  run("npm", ["init", "-y"], { cwd: dir });
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${PI_PACKAGE}@${version}`,
    ],
    { cwd: dir },
  );

  const piEntry = piEntryOf(dir);
  if (!existsSync(piEntry)) fail(`pi entry missing after install: ${piEntry}`);
  const installed = piVersion(piEntry);
  if (installed !== version) {
    fail(`version mismatch: expected ${version}, got ${installed}`);
  }
  console.log(`BUILD version-ok installed=${installed}`);

  console.log("BUILD rpc-smoke (offline)");
  await rpcSmoke(piEntry, dir, [
    ["c1", "get_commands"],
    ["s1", "get_state"],
  ]);
  console.log("BUILD rpc-smoke pass");

  const tarball = packTarball(dir, version, out);
  const sha256 = sha256File(tarball);
  writeFileSync(
    resolve(out, "SHA256SUMS"),
    `sha256 ${sha256}  pi-engine-${version}.tgz\n`,
    "utf8",
  );

  const manifest = buildManifest({
    version,
    publishedAt: new Date().toISOString().slice(0, 10),
    sha256,
    changelog: options.changelog ?? DEFAULT_CHANGELOG,
    breaking: options.breaking ?? BREAKING_EMPTY,
  });
  writeManifest(dir, manifest);

  console.log(`BUILD_OK version=${version} dir=${dir} tarball=${tarball}`);
  return { dir, tarball, manifest };
}

export async function verifyBundle(bundleDir) {
  const dir = resolve(bundleDir);
  const manifest = readManifest(dir);
  const piEntry = piEntryOf(dir);
  if (!existsSync(piEntry)) fail(`pi entry missing: ${piEntry}`);

  const installed = piVersion(piEntry);
  if (installed !== manifest.version) {
    fail(`version mismatch: manifest=${manifest.version} installed=${installed}`);
  }
  console.log(`VERIFY version-ok installed=${installed}`);

  console.log("VERIFY rpc-smoke (offline)");
  await rpcSmoke(piEntry, dir, [
    ["c1", "get_commands"],
    ["s1", "get_state"],
  ]);
  console.log("VERIFY rpc-smoke pass");

  const tarball = resolve(dirname(dir), `pi-engine-${manifest.version}.tgz`);
  if (existsSync(tarball)) {
    const actual = sha256File(tarball);
    if (actual !== manifest.sha256) {
      fail(`sha256 mismatch: manifest=${manifest.sha256} tarball=${actual}`);
    }
    console.log(`VERIFY sha256-ok tarball=${tarball}`);
  } else {
    console.log(`VERIFY tarball-absent (skip checksum, expected for staged dirs)`);
  }

  console.log(`VERIFY_OK dir=${dir} version=${manifest.version}`);
  return { ok: true, manifest };
}

export function emitManifest(bundleDir, { emit = false } = {}) {
  const dir = resolve(bundleDir);
  const manifest = readManifest(dir);
  if (emit) writeManifest(dir, manifest);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (emit) console.log(`MANIFEST_WRITTEN dir=${dir}`);
  return json;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "build") {
    await buildVersion(options.version, options);
  } else if (options.command === "verify") {
    await verifyBundle(options.dir);
  } else {
    const json = emitManifest(options.dir, options);
    process.stdout.write(json);
  }
}

const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`ENGINE_BUNDLE error message=${error.message}`);
    process.exitCode = 1;
  });
}
