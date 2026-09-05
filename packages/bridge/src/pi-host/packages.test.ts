import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  parsePackageSource,
  piPackageIdentity,
  listPiPackages,
  persistPackageSource,
  installPiPackage,
  removePiPackage,
  updatePiPackages,
  gitInstallPath,
  npmInstallPath,
  npmInstallRoot,
  type CommandRunner,
} from "./packages.js";
import { SettingsFile, piAgentFiles } from "./surfaces.js";

/** Fresh sandbox: home (piHome) + a project cwd. */
function makeHome(): { root: string; piHome: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "pix-packages-"));
  const piHome = join(root, "home");
  const cwd = join(root, "proj");
  mkdirSync(piHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, piHome, cwd };
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function settingsFile(cwd: string, piHome: string, scope: "user" | "project"): SettingsFile {
  return new SettingsFile(
    scope === "project" ? join(cwd, ".pi", "settings.json") : piAgentFiles(piHome).settings,
  );
}

/** Command runner that records invocations and simulates success. */
function recordingRunner(): { run: CommandRunner; calls: Array<{ cmd: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return "";
  };
  return { run, calls };
}

/** Runner that simulates an npm root lookup. */
function npmRootRunner(globalRoot: string): { run: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "npm" && args[0] === "root") return globalRoot;
    return "";
  };
  return { run, calls };
}

/** Runner that records invocations and simulates a git clone creating the target. */
function gitCloningRunner(): {
  run: CommandRunner;
  calls: Array<{ cmd: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const run: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    if (cmd === "git" && args[0] === "clone" && args[2]) {
      mkdirSync(args[2], { recursive: true });
      writeFileSync(join(args[2], "package.json"), JSON.stringify({ name: "repo" }, null, 2), "utf8");
    }
    return "";
  };
  return { run, calls };
}

function writePackage(dir: string, pkg: { name: string; version?: string; pi?: Record<string, string[]> }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
}

describe("parsePackageSource (1:1 with pi package-manager.ts)", () => {
  it("parses npm sources with and without versions", () => {
    expect(parsePackageSource("npm:lodash")).toEqual({
      type: "npm",
      spec: "lodash",
      name: "lodash",
      version: undefined,
      pinned: false,
    });
    expect(parsePackageSource("npm:lodash@1.2.3")).toEqual({
      type: "npm",
      spec: "lodash@1.2.3",
      name: "lodash",
      version: "1.2.3",
      pinned: true,
    });
    expect(parsePackageSource("npm:lodash@^1.2.0").pinned).toBe(false);
    expect(parsePackageSource("npm:lodash@1.2.3-beta.1").pinned).toBe(true);
  });

  it("parses scoped npm packages correctly (pi parseNpmSpec regex)", () => {
    expect(parsePackageSource("npm:@scope/pkg")).toEqual({
      type: "npm",
      spec: "@scope/pkg",
      name: "@scope/pkg",
      version: undefined,
      pinned: false,
    });
    expect(parsePackageSource("npm:@scope/pkg@2.0.0").version).toBe("2.0.0");
    expect(parsePackageSource("npm:@scope/pkg@2.0.0").name).toBe("@scope/pkg");
  });

  it("treats anything without a remote prefix as local (pi isLocalPath)", () => {
    expect(parsePackageSource("./ext").type).toBe("local");
    expect(parsePackageSource("/abs/path").type).toBe("local");
    expect(parsePackageSource("~/ext").type).toBe("local");
    expect(parsePackageSource("file:./ext").type).toBe("local");
    // bare relative paths are local too — mirroring pi exactly
    expect(parsePackageSource("my-folder/ext").type).toBe("local");
    expect(parsePackageSource("github.com/user/repo").type).toBe("local");
    expect(parsePackageSource("git@github.com:user/repo").type).toBe("local");
  });

  it("parses explicit-protocol git URLs", () => {
    expect(parsePackageSource("https://github.com/user/repo")).toEqual({
      type: "git",
      repo: "https://github.com/user/repo",
      host: "github.com",
      path: "user/repo",
      ref: undefined,
    });
    // scp-like without the git: prefix is a local path (1:1 with pi parseSource)
    expect(parsePackageSource("git@github.com:user/repo").type).toBe("local");
    expect(parsePackageSource("ssh://git@github.com/user/repo").type).toBe("git");
    // git:// URLs hit pi's `git:` prefix strip and fall back to local (faithful quirk)
    expect(parsePackageSource("git://github.com/user/repo.git").type).toBe("local");
  });

  it("accepts shorthand under the git: prefix and splits #ref", () => {
    expect(parsePackageSource("git:github.com/user/repo")).toEqual({
      type: "git",
      repo: "https://github.com/user/repo",
      host: "github.com",
      path: "user/repo",
      ref: undefined,
    });
    expect(parsePackageSource("git:github.com/user/repo#v1.0")).toEqual({
      type: "git",
      repo: "https://github.com/user/repo",
      host: "github.com",
      path: "user/repo",
      ref: "v1.0",
    });
    expect(parsePackageSource("git:git@github.com:user/repo").type).toBe("git");
    expect(parsePackageSource("git:github:user/repo").repo).toBe("https://github.com/user/repo");
  });
});

describe("piPackageIdentity (1:1 getPackageIdentity)", () => {
  it("uses npm:name, git:host/path, local:<resolved>", () => {
    expect(piPackageIdentity("npm:lodash@1.0.0", "/p")).toBe("npm:lodash");
    expect(piPackageIdentity("npm:@scope/pkg", "/p")).toBe("npm:@scope/pkg");
    expect(piPackageIdentity("https://github.com/u/r.git", "/p")).toBe("git:github.com/u/r");
    expect(piPackageIdentity("git:github.com/u/r#dev", "/p")).toBe("git:github.com/u/r");
    expect(piPackageIdentity("./ext", "/p")).toBe(`local:${join("/p", "ext")}`);
  });
});

describe("persistPackageSource (1:1 addSourceToSettings/removeSourceFromSettings)", () => {
  it("appends a new source and dedupes by identity", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "user");
      await persistPackageSource(cwd, piHome, "user", "npm:lodash@1.0.0", false);
      // same identity, different stored form → replaced in place, not duplicated
      await persistPackageSource(cwd, piHome, "user", "npm:lodash@2.0.0", false);
      const saved = (await file.load())["packages"] as string[];
      expect(saved).toEqual(["npm:lodash@2.0.0"]);
      // exact duplicate → no write, returns false
      const changed = await persistPackageSource(cwd, piHome, "user", "npm:lodash@2.0.0", false);
      expect(changed).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("removes a source by identity, returning false when absent", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "project");
      await persistPackageSource(cwd, piHome, "project", "npm:lodash", false);
      const removed = await persistPackageSource(cwd, piHome, "project", "npm:lodash", true);
      expect(removed).toBe(true);
      expect(((await file.load())["packages"] as string[]).length).toBe(0);
      const again = await persistPackageSource(cwd, piHome, "project", "npm:lodash", true);
      expect(again).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("normalizes local sources to a scope-relative path", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "user");
      await persistPackageSource(cwd, piHome, "user", "/abs/ext", false);
      const saved = (await file.load())["packages"] as string[];
      // relative to the user scope base dir (~/.pi/agent), mirroring pi
      const agentDir = piAgentFiles(piHome).agent;
      expect(saved[0]).toBe(relative(agentDir, "/abs/ext"));
      // re-resolving from the normalized form still matches the same identity
      const changed = await persistPackageSource(cwd, piHome, "user", "/abs/ext", false);
      expect(changed).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

describe("listPiPackages (pi list)", () => {
  it("enriches configured packages with install state + manifest metadata", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const userFile = settingsFile(cwd, piHome, "user");
      const projFile = settingsFile(cwd, piHome, "project");
      await userFile.update({ packages: ["npm:installed-pkg", "npm:missing-pkg", "./local-ext"] });
      await projFile.update({ packages: [{ source: "npm:filtered-pkg" }, "https://github.com/u/r"] });

      const npmRoot = join(root, "global-npm");
      // `npm root -g` output IS the node_modules dir; legacy packages live directly inside it
      const installedPkg = join(npmRoot, "installed-pkg");
      writePackage(installedPkg, { name: "installed-pkg", version: "3.1.4", pi: { skills: ["a.md"], themes: ["t.json"] } });
      // project-scope npm install dir (cwd/.pi/npm/node_modules)
      writePackage(join(cwd, ".pi", "npm", "node_modules", "filtered-pkg"), { name: "filtered-pkg", version: "0.0.2" });
      // local source resolves from the user scope base dir (~/.pi/agent)
      writePackage(join(root, "home", ".pi", "agent", "local-ext"), { name: "local-ext" });
      // project git install dir
      writePackage(join(cwd, ".pi", "git", "github.com", "u", "r"), { name: "r", version: "1.0.0" });

      const { run } = npmRootRunner(npmRoot);
      const list = await listPiPackages(cwd, piHome, {}, run);

      // project scope first (mirrors engine iteration order)
      expect(list.map((p) => p.source)).toEqual([
        "npm:filtered-pkg",
        "https://github.com/u/r",
        "npm:installed-pkg",
        "npm:missing-pkg",
        "./local-ext",
      ]);
      expect(list[0].scope).toBe("project");
      expect(list[0].filtered).toBe(true);
      expect(list[0].displayName).toBe("filtered-pkg");
      expect(list[0].version).toBe("0.0.2");
      expect(list[0].resourceTypes).toEqual([]);
      const git = list[1];
      expect(git.type).toBe("git");
      expect(git.installedPath).toBe(join(cwd, ".pi", "git", "github.com", "u", "r"));
      const installed = list[2];
      expect(installed.installedPath).toBe(installedPkg);
      expect(installed.resourceTypes).toEqual(["skills", "themes"]);
      // missing npm package has no install dir but is still listed
      expect(list[3].installedPath).toBeUndefined();
    } finally {
      cleanup(root);
    }
  });

  it("includeMissing:false drops uninstalled packages", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const userFile = settingsFile(cwd, piHome, "user");
      await userFile.update({ packages: ["npm:present", "npm:absent"] });
      const npmRoot = join(root, "global-npm");
      writePackage(join(npmRoot, "present"), { name: "present", version: "1.0.0" });
      const { run } = npmRootRunner(npmRoot);
      const list = await listPiPackages(cwd, piHome, { includeMissing: false }, run);
      expect(list.map((p) => p.source)).toEqual(["npm:present"]);
    } finally {
      cleanup(root);
    }
  });
});

describe("installPiPackage (pi install)", () => {
  it("installs npm packages with --prefix and persists the source", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const { run, calls } = recordingRunner();
      await installPiPackage(cwd, piHome, "npm:some-pkg@1.0.0", { run });
      const installCall = calls.find((c) => c.cmd === "npm" && c.args[0] === "install");
      expect(installCall?.args).toEqual([
        "install",
        "some-pkg@1.0.0",
        "--prefix",
        npmInstallRoot(cwd, piHome, "user"),
        "--legacy-peer-deps",
      ]);
      const saved = (await settingsFile(cwd, piHome, "user").load())["packages"] as string[];
      expect(saved).toEqual(["npm:some-pkg@1.0.0"]);
    } finally {
      cleanup(root);
    }
  });

  it("installs git packages: clone → checkout ref → npm install --omit=dev", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const { run, calls } = gitCloningRunner();
      await installPiPackage(cwd, piHome, "git:github.com/user/repo#v1.2.0", { run });
      const target = gitInstallPath(
        { type: "git", repo: "https://github.com/user/repo", host: "github.com", path: "user/repo", ref: "v1.2.0" },
        cwd,
        piHome,
        "user",
      );
      expect(calls.some((c) => c.cmd === "git" && c.args[0] === "clone" && c.args[2] === target)).toBe(true);
      const checkout = calls.find((c) => c.cmd === "git" && c.args[0] === "checkout");
      expect(checkout?.args).toEqual(["checkout", "v1.2.0"]);
      expect(checkout?.cwd).toBe(target);
      expect(calls.some((c) => c.cmd === "npm" && c.args[0] === "install" && c.args[1] === "--omit=dev")).toBe(true);
      expect((await settingsFile(cwd, piHome, "user").load())["packages"] as string[]).toEqual([
        "git:github.com/user/repo#v1.2.0",
      ]);
    } finally {
      cleanup(root);
    }
  });

  it("refreshes an existing git clone to the configured ref", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const target = join(piHome, ".pi", "agent", "git", "github.com", "u", "r");
      writePackage(target, { name: "r" });
      const { run, calls } = recordingRunner();
      await installPiPackage(cwd, piHome, "git:github.com/u/r#main", { run });
      // no clone for existing dir; fetch + hard reset to the ref
      expect(calls.some((c) => c.cmd === "git" && c.args[0] === "clone")).toBe(false);
      const fetch = calls.find((c) => c.cmd === "git" && c.args[0] === "fetch");
      expect(fetch?.args).toContain("+refs/heads/main");
      expect(calls.some((c) => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "--hard")).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("rejects missing local paths (mirror pi install error)", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const { run } = recordingRunner();
      await expect(installPiPackage(cwd, piHome, "/nope/missing", { run })).rejects.toThrow(
        "Path does not exist",
      );
    } finally {
      cleanup(root);
    }
  });
});

describe("removePiPackage (pi remove)", () => {
  it("uninstalls npm artifacts and drops the setting", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "user");
      await file.update({ packages: ["npm:bye@1.0.0"] });
      const npmRoot = npmInstallRoot(cwd, piHome, "user");
      writePackage(join(npmRoot, "node_modules", "bye"), { name: "bye" });
      const { run, calls } = recordingRunner();
      const { removed } = await removePiPackage(cwd, piHome, "npm:bye", { run });
      expect(removed).toBe(true);
      const uninstall = calls.find((c) => c.cmd === "npm" && c.args[0] === "uninstall");
      expect(uninstall?.args[1]).toBe("bye");
      expect(((await file.load())["packages"] as string[]).length).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("removes git install dirs and prunes empty parents", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "project");
      await file.update({ packages: ["https://github.com/u/r"] });
      const target = join(cwd, ".pi", "git", "github.com", "u", "r");
      writePackage(target, { name: "r" });
      const { run } = recordingRunner();
      const { removed } = await removePiPackage(cwd, piHome, "https://github.com/u/r", { local: true, run });
      expect(removed).toBe(true);
      expect(existsSync(target)).toBe(false);
      expect(((await file.load())["packages"] as string[]).length).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("reports removed:false when the source is not configured", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const { run } = recordingRunner();
      const { removed } = await removePiPackage(cwd, piHome, "npm:not-there", { run });
      expect(removed).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});

describe("updatePiPackages (pi update)", () => {
  it("skips pinned npm versions, updates unpinned ones", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "user");
      await file.update({ packages: ["npm:pinned@1.0.0", "npm:floating"] });
      const rootDir = npmInstallRoot(cwd, piHome, "user");
      writePackage(join(rootDir, "node_modules", "pinned"), { name: "pinned" });
      writePackage(join(rootDir, "node_modules", "floating"), { name: "floating" });
      const { run, calls } = recordingRunner();
      const { updated } = await updatePiPackages(cwd, piHome, undefined, { run });
      expect(updated).toEqual(["npm:floating"]);
      const installs = calls.filter((c) => c.cmd === "npm" && c.args[0] === "install");
      expect(installs.length).toBe(1);
      expect(installs[0]?.args[1]).toBe("floating");
    } finally {
      cleanup(root);
    }
  });

  it("installs missing git packages and updates existing ones to origin/HEAD", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "user");
      await file.update({ packages: ["https://github.com/u/new", "https://github.com/u/old"] });
      writePackage(join(piHome, ".pi", "agent", "git", "github.com", "u", "old"), { name: "old" });
      const { run, calls } = recordingRunner();
      const { updated } = await updatePiPackages(cwd, piHome, undefined, { run });
      expect(updated).toEqual(["https://github.com/u/new", "https://github.com/u/old"]);
      expect(calls.some((c) => c.cmd === "git" && c.args[0] === "clone")).toBe(true);
      const setHead = calls.find((c) => c.cmd === "git" && c.args[0] === "remote");
      expect(setHead?.args).toEqual(["remote", "set-head", "origin", "-a"]);
      expect(calls.some((c) => c.cmd === "git" && c.args[0] === "reset" && c.args[1] === "--hard")).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("updates a single source filtered by identity", async () => {
    const { root, piHome, cwd } = makeHome();
    try {
      const file = settingsFile(cwd, piHome, "user");
      await file.update({ packages: ["npm:one", "npm:two"] });
      const rootDir = npmInstallRoot(cwd, piHome, "user");
      writePackage(join(rootDir, "node_modules", "one"), { name: "one" });
      writePackage(join(rootDir, "node_modules", "two"), { name: "two" });
      const { run } = recordingRunner();
      const { updated } = await updatePiPackages(cwd, piHome, "npm:two", { run });
      expect(updated).toEqual(["npm:two"]);
    } finally {
      cleanup(root);
    }
  });
});

describe("install paths (1:1 getNpmInstallRoot/getGitInstallPath)", () => {
  it("resolves project and user roots", () => {
    const { piHome, cwd } = makeHome();
    expect(npmInstallRoot(cwd, piHome, "project")).toBe(join(cwd, ".pi", "npm"));
    expect(npmInstallRoot(cwd, piHome, "user")).toBe(join(piHome, ".pi", "agent", "npm"));
    expect(npmInstallPath({ type: "npm", spec: "x", name: "x", pinned: false }, cwd, piHome, "user")).toBe(
      join(piHome, ".pi", "agent", "npm", "node_modules", "x"),
    );
  });
});
