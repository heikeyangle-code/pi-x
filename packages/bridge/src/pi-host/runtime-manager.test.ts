import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runtimeLayout,
  resolveRouteCommandPrefix,
  probeRuntimeStatus,
  installRuntime,
  createRuntimeHooks,
  PROROOT_LIBS,
  RuntimeInstallError,
  type RuntimeInstallHost,
  type ProgressSink,
} from "./runtime-manager.js";
import { PixConfigFile } from "./pix-config.js";
import { piAgentFiles } from "./surfaces.js";

function workDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

async function writePixConfig(piHome: string, config: object): Promise<void> {
  const file = piAgentFiles(piHome).pixConfig;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config), "utf8");
}

function fakeHost(overrides: Partial<RuntimeInstallHost> = {}): RuntimeInstallHost {
  return {
    prorootLibAvailable: () => true,
    pkgAvailable: () => true,
    downloadRootfs: async (_dest, _onProgress) => ({
      rootfsSize: 1234,
      sha256: "abc123",
    }),
    run: async () => {},
    ...overrides,
  };
}

describe("resolveRouteCommandPrefix", () => {
  it("returns undefined for the built-in bionic route", () => {
    const layout = runtimeLayout("/tmp/pi-home");
    expect(
      resolveRouteCommandPrefix({ route: "bionic", cwd: "/w", layout }),
    ).toBeUndefined();
  });

  it("builds the proroot wrapper with rootfs, cwd and binds before --", () => {
    const layout = runtimeLayout("/home/u/.pi");
    const argv = resolveRouteCommandPrefix({
      route: "proroot",
      cwd: "/data/pi/workspace",
      layout,
      bindDirs: ["/data/pi/workspace", "/home/u/.pi", "/engines"],
    });
    expect(argv).toEqual([
      "/home/u/.pi/runtimes/proroot/libproroot.so",
      "-r",
      "/home/u/.pi/runtimes/proroot/rootfs",
      "-0",
      "--link2symlink",
      "-w",
      "/data/pi/workspace",
      "-b",
      "/data/pi/workspace:/data/pi/workspace",
      "-b",
      "/home/u/.pi:/home/u/.pi",
      "-b",
      "/engines:/engines",
      "--",
    ]);
  });

  it("builds the proot-distro login wrapper (default ubuntu alias)", () => {
    const layout = runtimeLayout("/home/u/.pi");
    const argv = resolveRouteCommandPrefix({
      route: "proot-distro",
      cwd: "/w",
      layout,
      bindDirs: ["/w"],
    });
    expect(argv).toEqual([
      "proot-distro",
      "login",
      "ubuntu",
      "--cwd",
      "/w",
      "--bind",
      "/w:/w",
      "--",
    ]);
  });

  it("honors a custom distro alias", () => {
    const layout = runtimeLayout("/home/u/.pi");
    const argv = resolveRouteCommandPrefix({
      route: "proot-distro",
      cwd: "/w",
      layout,
      distroAlias: "debian",
    });
    expect(argv?.slice(0, 3)).toEqual(["proot-distro", "login", "debian"]);
  });
});

describe("probeRuntimeStatus", () => {
  it("reports not installed when nothing is present", async () => {
    const layout = runtimeLayout(workDir("rt-empty"));
    const status = await probeRuntimeStatus({
      route: "bionic",
      layout,
      installable: ["bionic", "proroot"],
    });
    expect(status.prorootInstalled).toBe(false);
    expect(status.prootDistroInstalled).toBe(false);
    expect(status.rootfsSize).toBeUndefined();
    expect(status.available).toEqual(["bionic", "proroot"]);
  });

  it("reports proroot installed only when lib + rootfs + meta agree", async () => {
    const piHome = workDir("rt-proroot");
    const layout = runtimeLayout(piHome);
    await mkdir(layout.proroot.rootfsDir, { recursive: true });
    await writeFile(join(layout.proroot.rootfsDir, ".extracted"), "ok");
    await writeFile(join(layout.proroot.libDir, "libproroot.so"), "x");
    // lib + rootfs but no meta -> not installed yet (install not finished).
    const noMeta = await probeRuntimeStatus({
      route: "proroot",
      layout,
      prorootLibPresent: true,
      installable: ["bionic"],
    });
    expect(noMeta.prorootInstalled).toBe(false);

    await writeFile(
      layout.proroot.metaFile,
      JSON.stringify({ installedAt: "2026-09-05T00:00:00Z", rootfsSize: 42 }),
    );
    const done = await probeRuntimeStatus({
      route: "proroot",
      layout,
      installable: ["bionic"],
    });
    expect(done.prorootInstalled).toBe(true);
    expect(done.rootfsSize).toBe(42);
  });

  it("reports proot-distro installed from its meta file", async () => {
    const piHome = workDir("rt-distro");
    const layout = runtimeLayout(piHome);
    const status = await probeRuntimeStatus({
      route: "proot-distro",
      layout,
      installable: ["bionic"],
    });
    expect(status.prootDistroInstalled).toBe(false);

    await mkdir(dirname(layout.prootDistro.metaFile), { recursive: true });
    await writeFile(
      layout.prootDistro.metaFile,
      JSON.stringify({ installedAt: "2026-09-05T00:00:00Z", packages: ["nodejs"] }),
    );
    const done = await probeRuntimeStatus({
      route: "proot-distro",
      layout,
      installable: ["bionic"],
    });
    expect(done.prootDistroInstalled).toBe(true);
    expect(done.installedPackages).toEqual(["nodejs"]);
  });
});

describe("installRuntime", () => {
  it("proroot: fails fast when the libs are missing", async () => {
    const layout = runtimeLayout(workDir("rt-install"));
    const result = await installRuntime(
      "proroot",
      layout,
      fakeHost({ prorootLibAvailable: () => false }),
    );
    expect(result).toEqual({ success: false, error: "proroot_libs_missing" });
  });

  it("proroot: downloads into the layout and writes meta", async () => {
    const piHome = workDir("rt-install-ok");
    const layout = runtimeLayout(piHome);
    const download = vi.fn(async (dest: string, _p: ProgressSink) => {
      await mkdir(join(dest, "bin"), { recursive: true });
      await writeFile(join(dest, "bin", "node"), "bin");
      return { rootfsSize: 1234, sha256: "deadbeef" };
    });
    const progress: string[] = [];
    const result = await installRuntime(
      "proroot",
      layout,
      fakeHost({ downloadRootfs: download }),
      (p) => progress.push(`${p.stage}:${p.percent}`),
    );
    expect(result).toEqual({ success: true });
    expect(download).toHaveBeenCalledTimes(1);
    const [dest] = download.mock.calls[0]!;
    expect(dest).toBe(layout.proroot.rootfsDir);

    const meta = JSON.parse(
      await (await import("node:fs/promises")).readFile(layout.proroot.metaFile, "utf8"),
    ) as { installedAt: string; rootfsSize: number; sha256: string };
    expect(meta.rootfsSize).toBe(1234);
    expect(meta.sha256).toBe("deadbeef");
    expect(meta.installedAt).toBeTruthy();
    expect(progress).toContain("done:100");
  });

  it("proroot: downloads libs when missing, then rootfs", async () => {
    const piHome = workDir("rt-install-libs");
    const layout = runtimeLayout(piHome);
    const libDirs: string[] = [];
    const downloaded: string[][] = [];
    const result = await installRuntime(
      "proroot",
      layout,
      fakeHost({
        prorootLibAvailable: () =>
          // The download below writes libproroot.so into the layout, so a
          // filesystem-based probe flips to true after installProrootLibs runs.
          existsSync(join(layout.proroot.libDir, "libproroot.so")),
        installProrootLibs: async (dest) => {
          libDirs.push(dest);
          await mkdir(dest, { recursive: true });
          downloaded.push(PROROOT_LIBS.map((e) => e.file));
          await writeFile(join(dest, "libproroot.so"), "x");
        },
      }),
    );
    expect(result).toEqual({ success: true });
    expect(libDirs).toEqual([layout.proroot.libDir]);
    expect(downloaded[0]).toHaveLength(PROROOT_LIBS.length);
    expect(downloaded[0]).toContain("libproroot.so");
    expect(downloaded[0]).toContain("libproroot-runtime.so");
  });

  it("proroot: defers to an already-present libproroot.so (no download)", async () => {
    const piHome = workDir("rt-install-libspresent");
    const layout = runtimeLayout(piHome);
    await mkdir(layout.proroot.libDir, { recursive: true });
    await writeFile(join(layout.proroot.libDir, "libproroot.so"), "spot");
    const installProrootLibs = vi.fn(async () => {});
    const result = await installRuntime(
      "proroot",
      layout,
      fakeHost({ installProrootLibs }),
    );
    expect(result).toEqual({ success: true });
    expect(installProrootLibs).not.toHaveBeenCalled();
  });

  it("proroot: libs download failure still propagates as an error result", async () => {
    const layout = runtimeLayout(workDir("rt-install-libsfail"));
    const result = await installRuntime(
      "proroot",
      layout,
      fakeHost({
        prorootLibAvailable: () => false,
        installProrootLibs: async () => {
          throw new RuntimeInstallError("libs_failed");
        },
      }),
    );
    expect(result).toEqual({ success: false, error: "libs_failed" });
  });

  it("proroot: propagates a download failure as an error result", async () => {
    const layout = runtimeLayout(workDir("rt-install-fail"));
    const result = await installRuntime(
      "proroot",
      layout,
      fakeHost({
        downloadRootfs: async () => {
          throw new RuntimeInstallError("boom");
        },
      }),
    );
    expect(result).toEqual({ success: false, error: "boom" });
  });

  it("proot-distro: fails fast without the termux pkg toolchain", async () => {
    const layout = runtimeLayout(workDir("rt-distro-fail"));
    const result = await installRuntime(
      "proot-distro",
      layout,
      fakeHost({ pkgAvailable: () => false }),
    );
    expect(result).toEqual({
      success: false,
      error: "proot_distro_requires_termux",
    });
  });

  it("proot-distro: runs the full bootstrap and writes meta", async () => {
    const layout = runtimeLayout(workDir("rt-distro-ok"));
    const commands: Array<[string, string[]]> = [];
    const progress: number[] = [];
    const result = await installRuntime(
      "proot-distro",
      layout,
      fakeHost({
        run: async (cmd, args) => {
          commands.push([cmd, args]);
        },
      }),
      (p) => progress.push(p.percent),
    );
    expect(result).toEqual({ success: true });
    expect(commands.map(([cmd]) => cmd)).toEqual([
      "pkg",
      "proot-distro",
      "proot-distro",
      "proot-distro",
      "proot-distro",
    ]);
    expect(commands[0]![1]).toEqual(["install", "-y", "proot", "proot-distro"]);
    expect(commands[1]![1]).toEqual(["install", "ubuntu"]);
    expect(commands[4]![1]).toContain("@earendil-works/pi-coding-agent");

    const meta = JSON.parse(
      await (await import("node:fs/promises")).readFile(layout.prootDistro.metaFile, "utf8"),
    ) as { installedAt: string; packages: string[] };
    expect(meta.installedAt).toBeTruthy();
    expect(meta.packages).toContain("pi");
    // Percentages must be monotonic within [0, 100].
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[progress.length - 1]).toBe(100);
  });
});

describe("createRuntimeHooks", () => {
  it("resolves the prefix from the persisted route (installed -> wrapper)", async () => {
    const piHome = workDir("hooks-prefix");
    const layout = runtimeLayout(piHome);
    await mkdir(layout.proroot.rootfsDir, { recursive: true });
    await writeFile(join(layout.proroot.rootfsDir, ".extracted"), "ok");
    await writeFile(join(layout.proroot.libDir, "libproroot.so"), "x");
    await writeFile(
      layout.proroot.metaFile,
      JSON.stringify({ installedAt: "2026-09-05T00:00:00Z" }),
    );
    await writePixConfig(piHome, { runtimeRoute: "proroot" });

    const hooks = createRuntimeHooks({
      piHome,
      layout,
      enginesDir: "/engines",
      host: fakeHost(),
    });
    const argv = await hooks.resolveCommandPrefix("/w");
    expect(argv).toBeDefined();
    expect(argv?.[0]).toBe(join(layout.proroot.libDir, "libproroot.so"));
    expect(argv).toContain("--");
    // Binds include cwd, pi home and the engines dir.
    expect(argv).toContain("-b");
    expect(argv).toContain("/engines:/engines");
  });

  it("resolves undefined prefix when the B route is configured but not installed", async () => {
    const piHome = workDir("hooks-notinstalled");
    const layout = runtimeLayout(piHome);
    await writePixConfig(piHome, { runtimeRoute: "proroot" });
    const hooks = createRuntimeHooks({ piHome, layout, host: fakeHost() });
    expect(await hooks.resolveCommandPrefix("/w")).toBeUndefined();
  });

  it("status() merges config route with installable capabilities", async () => {
    const piHome = workDir("hooks-status");
    const layout = runtimeLayout(piHome);
    await writePixConfig(piHome, { runtimeRoute: "proot-distro" });
    const hooks = createRuntimeHooks({
      piHome,
      layout,
      host: fakeHost({ pkgAvailable: () => false }),
    });
    const status = await hooks.status();
    expect(status.route).toBe("proot-distro");
    expect(status.available).toEqual(["bionic", "proroot"]);
  });

  it("install() maps success/error through the RPC shape", async () => {
    const piHome = workDir("hooks-install");
    const layout = runtimeLayout(piHome);
    const hooks = createRuntimeHooks({
      piHome,
      layout,
      host: fakeHost({ prorootLibAvailable: () => false }),
    });
    expect(await hooks.install("proroot")).toEqual({
      success: false,
      error: "proroot_libs_missing",
    });
    expect(await hooks.install("proroot", () => {})).toEqual({
      success: false,
      error: "proroot_libs_missing",
    });
  });

  it("config round-trips via PixConfigFile (shared with the gateway)", async () => {
    const piHome = workDir("hooks-config");
    const file = new PixConfigFile(piAgentFiles(piHome).pixConfig);
    await file.update({ runtimeRoute: "proot-distro" });
    expect((await file.load()).runtimeRoute).toBe("proot-distro");
  });
});
