// Unit tests for scripts/engine-bundle.mjs pure logic (no real pi install).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BREAKING_EMPTY,
  buildManifest,
  isSemver,
  normalizeManifest,
  parseArgs,
  validateManifest,
} from "./engine-bundle.mjs";

test("parseArgs: build requires a version", () => {
  assert.throws(() => parseArgs(["build"]), /build requires <version>/);
  assert.deepEqual(parseArgs(["build", "0.85.0"]), {
    command: "build",
    version: "0.85.0",
  });
  assert.deepEqual(parseArgs(["build", "0.85.0", "--out", "engines"]), {
    command: "build",
    version: "0.85.0",
    out: "engines",
  });
  assert.deepEqual(parseArgs(["build", "0.85.0", "--changelog", "https://x.dev/c"]), {
    command: "build",
    version: "0.85.0",
    changelog: "https://x.dev/c",
  });
});

test("parseArgs: verify/manifest take a bundle dir", () => {
  assert.throws(() => parseArgs(["verify"]), /verify requires <bundleDir>/);
  assert.deepEqual(parseArgs(["verify", "engines/0.85.0"]), {
    command: "verify",
    dir: "engines/0.85.0",
  });
  assert.deepEqual(parseArgs(["manifest", "engines/0.85.0", "--emit"]), {
    command: "manifest",
    dir: "engines/0.85.0",
    emit: true,
  });
});

test("parseArgs: unknown command and bad breaking JSON rejected", () => {
  assert.throws(() => parseArgs(["deploy"]), /build\|verify\|manifest/);
  assert.throws(
    () => parseArgs(["build", "0.85.0", "--breaking", "not-json"]),
    /--breaking must be valid JSON/,
  );
  const options = parseArgs(["build", "0.85.0", "--breaking", '{"notes":"x"}']);
  assert.deepEqual(options.breaking, { notes: "x" });
});

test("isSemver accepts release and pre-release, rejects garbage", () => {
  for (const ok of ["0.85.0", "1.2.3", "0.85.0-beta.1", "2.0.0-rc.1+build5"]) {
    assert.equal(isSemver(ok), true, ok);
  }
  for (const bad of ["85", "0.85", "v0.85.0", "latest", "", "0.85.0.1"]) {
    assert.equal(isSemver(bad), false, bad);
  }
});

test("buildManifest produces a valid manifest", () => {
  const manifest = buildManifest({
    version: "0.85.0",
    publishedAt: "2026-09-04",
    sha256: "a".repeat(64),
    changelog: "https://pi.dev/docs/changelog",
    breaking: BREAKING_EMPTY,
  });
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.requiresRuntime, ">=22.19.0");
  assert.equal(manifest.rpcSmoke, "pass");
});

test("validateManifest flags bad fields", () => {
  const errors = validateManifest(
    normalizeManifest({
      version: "nope",
      publishedAt: "yesterday",
      sha256: "abc",
      rpcSmoke: "fail",
      breaking: { sessionFormat: "yes", settings: {} },
    }),
  );
  assert.ok(errors.some((error) => error.includes("version")));
  assert.ok(errors.some((error) => error.includes("publishedAt")));
  assert.ok(errors.some((error) => error.includes("sha256")));
  assert.ok(errors.some((error) => error.includes("rpcSmoke")));
  assert.ok(errors.some((error) => error.includes("sessionFormat")));
  assert.ok(errors.some((error) => error.includes("settings")));
});

test("validateManifest accepts full breaking payloads", () => {
  const manifest = buildManifest({
    version: "0.86.0",
    publishedAt: "2026-09-04",
    sha256: "b".repeat(64),
    changelog: "https://pi.dev/docs/changelog",
    breaking: {
      settings: ["defaultProjectTrust"],
      sessionFormat: true,
      notes: "session dir moved",
    },
  });
  assert.deepEqual(validateManifest(manifest), []);
});
