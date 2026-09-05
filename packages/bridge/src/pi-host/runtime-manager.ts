/**
 * Route B runtime manager — on-device state for the alternate full-Linux
 * runtimes (docs/ENGINE-BUNDLE.md "路线切换 UI 落地" / "路线 B 实现阶梯").
 *
 * Three routes coexist (never auto-detected, always user-chosen):
 *   - bionic (default): built-in node/tools, spawned directly (no prefix)
 *   - proroot: rootless LD_PRELOAD runtime; libproroot.so* ships in the APK
 *     (jniLibs/arm64-v8a); rootfs downloaded, SHA-verified, extracted
 *   - proot-distro: Termux toolchain (`pkg install proot proot-distro` ->
 *     `proot-distro install ubuntu`) + bootstrap inside the distro
 *
 * Layout (under $PI_HOME i.e. ~/.pi):
 *   runtimes/proroot/libproroot.so*        <- from APK jniLibs (or PIX_PROROOT_LIB_DIR)
 *   runtimes/proroot/rootfs/               <- downloaded/verified rootfs
 *   runtimes/proroot/installed.json        <- {installedAt, rootfsSize, packages, sha256}
 *   runtimes/proot-distro/installed.json   <- written after termux install + bootstrap
 *
 * Pure argv/fs logic is unit-tested; downloads and process execution are
 * injected (RuntimeInstallHost) so the production host wires real
 * implementations while tests stay hermetic.
 */

import { access, mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { dirname, join } from "node:path";

import { PixConfigFile, type RuntimeRoute } from "./pix-config.js";
import { piAgentFiles } from "./surfaces.js";
import type { RuntimeStatus } from "./pi-gateway.js";

/** Proroot runtime libs (v1.2.7): 5 .so files from GitHub Releases (SJA 校验). */
export const PROROOT_LIBS_VERSION = "v1.2.7";
export const PROROOT_LIBS_BASE_URL =
  "https://github.com/coderredlab/proroot/releases/download/v1.2.7";
/** Proroot 启动必须的文件：libproroot.so，其余 4 个为依赖。 */
export const PROROOT_LIBS: ReadonlyArray<{ file: string; sha256: string }> = [
  {
    file: "libproroot.so",
    sha256: "018132fff13bcbc8871d25da6b695cad2b583a1f143236de7cbd9aa7c646770b",
  },
  {
    file: "libproroot-runtime.so",
    sha256: "7978ade925b53897b9d9a106ffbf154c8d8e21650e150cd41a7d288f2ec24d38",
  },
  {
    file: "libproroot-bridge.so",
    sha256: "1c5bc9537a270e8bf8b1c70222813f57b60b828bfb5503ddf8fe37685092de2f",
  },
  {
    file: "libproroot-linker.so",
    sha256: "da9e6ddb6aac5241b3a8d5d28aeb590fe8fd34f7a819f309ddbcd68d7f093140",
  },
  {
    file: "libproroot-stub-loader.so",
    sha256: "c700a44c2810767e5f420988a3023808f36650dc899b70d59d0093c7a95b9742",
  },
];

/**
 * 默认 Ubuntu ARM64 rootfs 下载源（按需，不随 APK 内置）：
 * Ubuntu 26.04 LTS minimal cloud image (LXD/rootfs 格式)，xz 压缩。
 * 校验值来自该发布目录的 SHA256SUMS；`PIX_PROROOT_ROOTFS_URL` 可覆盖。
 */
export const DEFAULT_PROROOT_ROOTFS_URL =
  "https://us.cloud-images.ubuntu.com/minimal/releases/resolute/release-20260717/ubuntu-26.04-minimal-cloudimg-arm64-root.tar.xz";
export const DEFAULT_PROROOT_ROOTFS_SHA256 =
  "dc497f72349323499095aeca0aafa4a4b51ddcbe9f60a49a492ed7e58a5befe4";
export const DEFAULT_PROROOT_ROOTFS_FORMAT = "xz";
export const DEFAULT_PROROOT_ROOTFS_STRIP = 0;

/** Progress reported during `runtime_install` (percent 0-100, coarse stages). */
export interface RuntimeInstallProgress {
  stage: string;
  percent: number;
}

export type ProgressSink = (progress: RuntimeInstallProgress) => void;

/** Thrown by installers to surface a user-facing error string. */
export class RuntimeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeInstallError";
  }
}

/** On-device locations for route B runtimes (docs "运行时布局"). */
export interface RuntimeLayout {
  proroot: {
    libDir: string;
    rootfsDir: string;
    metaFile: string;
  };
  prootDistro: {
    metaFile: string;
  };
}

export function runtimeLayout(piHome: string): RuntimeLayout {
  const base = join(piHome, "runtimes");
  return {
    proroot: {
      libDir: join(base, "proroot"),
      rootfsDir: join(base, "proroot", "rootfs"),
      metaFile: join(base, "proroot", "installed.json"),
    },
    prootDistro: {
      metaFile: join(base, "proot-distro", "installed.json"),
    },
  };
}

interface RuntimeMeta {
  installedAt?: string;
  rootfsSize?: number;
  packages?: string[];
  sha256?: string;
}

async function readMeta(file: string): Promise<RuntimeMeta | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const raw = parsed as Record<string, unknown>;
    return {
      installedAt:
        typeof raw.installedAt === "string" ? raw.installedAt : undefined,
      rootfsSize:
        typeof raw.rootfsSize === "number" ? raw.rootfsSize : undefined,
      packages: Array.isArray(raw.packages)
        ? raw.packages.filter((p): p is string => typeof p === "string")
        : undefined,
      sha256: typeof raw.sha256 === "string" ? raw.sha256 : undefined,
    };
  } catch {
    return undefined;
  }
}

async function writeMeta(file: string, meta: RuntimeMeta): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Shared-dir binds for the cross-route shared model (workspace/pi/engines). */
export interface RouteCommandPrefixInput {
  route: RuntimeRoute;
  /** Engine working directory (workspace path). */
  cwd: string;
  layout: RuntimeLayout;
  /** proot-distro alias (docs default: ubuntu). */
  distroAlias?: string;
  /**
   * Host dirs bound to the SAME absolute path inside the runtime, so shared
   * data (workspace, $PI_HOME, engine bundle) is visible at identical paths.
   */
  bindDirs?: string[];
}

/**
 * Resolve the engine-spawn wrapper prefix for a route (docs §路线 B 启动方式).
 * Returns undefined for bionic (direct spawn). Callers fall back to a direct
 * spawn when a configured B route is not yet installed (status reports the
 * truth; the UI installs before switching).
 */
export function resolveRouteCommandPrefix(
  input: RouteCommandPrefixInput,
): string[] | undefined {
  const { route, cwd, layout } = input;
  switch (route) {
    case "bionic":
      return undefined;
    case "proroot": {
      const binds =
        input.bindDirs?.flatMap((d) => ["-b", `${d}:${d}`]) ?? [];
      return [
        join(layout.proroot.libDir, "libproroot.so"),
        "-r",
        layout.proroot.rootfsDir,
        "-0",
        "--link2symlink",
        "-w",
        cwd,
        ...binds,
        "--",
      ];
    }
    case "proot-distro": {
      const binds =
        input.bindDirs?.flatMap((d) => ["--bind", `${d}:${d}`]) ?? [];
      return [
        "proot-distro",
        "login",
        input.distroAlias ?? "ubuntu",
        "--cwd",
        cwd,
        ...binds,
        "--",
      ];
    }
  }
}

export interface RuntimeProbeInput {
  route: RuntimeRoute;
  layout: RuntimeLayout;
  /** Overrides for hermetic tests; undefined = real fs checks. */
  prorootLibPresent?: boolean;
  /** Routes the host can install (shown as installable in the UI). */
  installable: RuntimeRoute[];
}

/**
 * Filesystem probe for `get_runtime_status`. All side effects are fs reads;
 * the host may inject capability overrides for tests.
 */
export async function probeRuntimeStatus(
  input: RuntimeProbeInput,
): Promise<RuntimeStatus> {
  const { route, layout } = input;
  const prorootMeta = await readMeta(layout.proroot.metaFile);
  const prootDistroMeta = await readMeta(layout.prootDistro.metaFile);

  const prorootLibPresent =
    input.prorootLibPresent ??
    (await pathExists(join(layout.proroot.libDir, "libproroot.so")));
  const prorootRootfsOk = await isNonEmptyDir(layout.proroot.rootfsDir);
  const prorootInstalled = prorootLibPresent && prorootRootfsOk && prorootMeta?.installedAt !== undefined;

  const prootDistroInstalled =
    prootDistroMeta?.installedAt !== undefined;

  // Report the active route's install surface when available.
  const activeMeta =
    route === "proroot"
      ? prorootMeta
      : route === "proot-distro"
        ? prootDistroMeta
        : undefined;

  return {
    route,
    prorootInstalled,
    prootDistroInstalled,
    rootfsSize: activeMeta?.rootfsSize,
    installedPackages: activeMeta?.packages,
    available: input.installable,
  };
}

/** External effects used by installers (injected; real impls in the host). */
export interface RuntimeInstallHost {
  /** True when the proroot .so files are available on this host. */
  prorootLibAvailable(): Promise<boolean> | boolean;
  /** True when the Termux `pkg` toolchain is present. */
  pkgAvailable(): Promise<boolean> | boolean;
  /**
   * Download the 5 Proroot runtime libraries into `dest` (from GitHub
   * Releases by default, `PIX_PROROOT_LIBS_BASE_URL` to override). Only used
   * on install when the APK did not ship them in jniLibs. Throws
   * RuntimeInstallError on any failure.
   */
  installProrootLibs?(dest: string, onProgress: ProgressSink): Promise<void>;
  /**
   * Download + verify + extract a rootfs tarball into `dest` (created by the
   * manager). Throws RuntimeInstallError on any failure.
   */
  downloadRootfs(
    dest: string,
    onProgress: ProgressSink,
  ): Promise<{ rootfsSize?: number; sha256?: string }>;
  /** Run a host command; throws RuntimeInstallError on non-zero exit. */
  run(
    cmd: string,
    args: string[],
    onProgress?: ProgressSink,
  ): Promise<void>;
}

export type InstallResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Install a route B runtime (docs §runtime_install). Progress (percent+stage)
 * is delivered through the optional sink, which the gateway forwards as
 * `runtime_install_progress` events on the wire.
 */
export async function installRuntime(
  route: RuntimeRoute,
  layout: RuntimeLayout,
  host: RuntimeInstallHost,
  onProgress?: ProgressSink,
): Promise<InstallResult> {
  try {
    if (route === "proroot") {
      return await installProroot(layout, host, onProgress);
    }
    return await installProotDistro(layout, host, onProgress);
  } catch (err) {
    if (err instanceof RuntimeInstallError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}

async function installProroot(
  layout: RuntimeLayout,
  host: RuntimeInstallHost,
  onProgress?: ProgressSink,
): Promise<InstallResult> {
  let libOk = await host.prorootLibAvailable();
  // A route can be installed even when the APK did not ship the runtime libs:
  // fetch them from GitHub Releases first (PIX_PROROOT_LIBS_BASE_URL to point
  // elsewhere). libproroot.so* lands in layout.proroot.libDir next to the
  // rootfs kit, where probeRuntimeStatus() looks for it.
  if (!libOk && host.installProrootLibs !== undefined) {
    onProgress?.({ stage: "download libproroot", percent: 8 });
    await host.installProrootLibs(layout.proroot.libDir, onProgress ?? (() => {}));
    libOk = await host.prorootLibAvailable();
  }
  if (!libOk) {
    throw new RuntimeInstallError("proroot_libs_missing");
  }
  const rootfs = layout.proroot.rootfsDir;
  await mkdir(rootfs, { recursive: true });
  const { rootfsSize, sha256 } = await host.downloadRootfs(
    rootfs,
    onProgress ?? (() => {}),
  );
  await writeMeta(layout.proroot.metaFile, {
    installedAt: new Date().toISOString(),
    rootfsSize,
    sha256,
    packages: [],
  });
  onProgress?.({ stage: "done", percent: 100 });
  return { success: true };
}

async function installProotDistro(
  layout: RuntimeLayout,
  host: RuntimeInstallHost,
  onProgress?: ProgressSink,
): Promise<InstallResult> {
  const pkgOk = await host.pkgAvailable();
  if (!pkgOk) {
    throw new RuntimeInstallError("proot_distro_requires_termux");
  }
  const step = (stage: string, percent: number) =>
    onProgress?.({ stage, percent });

  step("pkg install proot proot-distro", 8);
  await host.run("pkg", ["install", "-y", "proot", "proot-distro"]);

  step("proot-distro install ubuntu", 35);
  await host.run("proot-distro", ["install", "ubuntu"]);

  step("bootstrap: apt-get update", 55);
  await host.run("proot-distro", ["login", "ubuntu", "--", "apt-get", "update", "-y"]);

  step("bootstrap: install toolchain", 65);
  await host.run("proot-distro", [
    "login",
    "ubuntu",
    "--",
    "apt-get",
    "install",
    "-y",
    "nodejs",
    "npm",
    "git",
    "ripgrep",
    "python3",
  ]);

  step("bootstrap: npm i -g pi engine", 85);
  await host.run("proot-distro", [
    "login",
    "ubuntu",
    "--",
    "npm",
    "install",
    "-g",
    "--ignore-scripts",
    "@earendil-works/pi-coding-agent",
  ]);

  await writeMeta(layout.prootDistro.metaFile, {
    installedAt: new Date().toISOString(),
    packages: [
      "proot",
      "proot-distro",
      "nodejs",
      "npm",
      "git",
      "ripgrep",
      "python3",
      "pi",
    ],
  });
  onProgress?.({ stage: "done", percent: 100 });
  return { success: true };
}

/**
 * Production hooks factory for the PiHost entry points. Wires real downloads
 * (PIX_PROROOT_ROOTFS_URL / PIX_PROROOT_ROOTFS_SHA256 / PIX_PROROOT_ROOTFS_STRIP)
 * and real process execution, with capability probes cached at startup.
 */
export interface RuntimeHooksOptions {
  piHome: string;
  env?: Record<string, string | undefined>;
  layout?: RuntimeLayout;
  /** Directory containing the engine bundle (bound into route B runtimes). */
  enginesDir?: string;
  /** Injected for tests. */
  host?: RuntimeInstallHost;
}

export interface RuntimeHooks {
  /** Per-cwd spawn prefix for the active route (undefined = direct spawn). */
  resolveCommandPrefix(cwd: string): Promise<string[] | undefined>;
  status(): Promise<RuntimeStatus>;
  install(
    route: RuntimeRoute,
    onProgress?: ProgressSink,
  ): Promise<{ success: boolean; error?: string }>;
}

export function createRuntimeHooks(
  opts: RuntimeHooksOptions,
): RuntimeHooks {
  const piHome = opts.piHome;
  const env = opts.env ?? process.env;
  const layout = opts.layout ?? runtimeLayout(piHome);
  const host = opts.host ?? createHostImplementations(layout, env);

  const readRoute = async (): Promise<RuntimeRoute> => {
    const files = piAgentFiles(piHome);
    const cfg = await new PixConfigFile(files.pixConfig).load();
    return cfg.runtimeRoute ?? "bionic";
  };

  return {
    async resolveCommandPrefix(cwd: string): Promise<string[] | undefined> {
      const route = await readRoute();
      if (route === "bionic") return undefined;
      // Only wrap when the runtime is actually installed; otherwise fall back
      // to a direct spawn (status reports the truth, UI installs first).
      const status = await probeRuntimeStatus({
        route,
        layout,
        installable: [],
      });
      const installed =
        route === "proroot"
          ? status.prorootInstalled
          : status.prootDistroInstalled;
      if (!installed) return undefined;
      const bindDirs = [cwd, piHome];
      if (opts.enginesDir) bindDirs.push(opts.enginesDir);
      return resolveRouteCommandPrefix({ route, cwd, layout, bindDirs });
    },

    async status(): Promise<RuntimeStatus> {
      const route = await readRoute();
      const installable: RuntimeRoute[] = ["bionic"];
      if (await host.prorootLibAvailable()) installable.push("proroot");
      if (await host.pkgAvailable()) installable.push("proot-distro");
      return probeRuntimeStatus({ route, layout, installable });
    },

    async install(route, onProgress): Promise<{ success: boolean; error?: string }> {
      const result = await installRuntime(route, layout, host, onProgress);
      return result.success ? { success: true } : { success: false, error: result.error };
    },
  };
}

/** Default host implementations: fs probes, https download, process spawn. */
function createHostImplementations(
  layout: RuntimeLayout,
  env: Record<string, string | undefined>,
): RuntimeInstallHost {
  const prorootLibDir = env.PIX_PROROOT_LIB_DIR ?? layout.proroot.libDir;

  const prorootLibAvailable = async (): Promise<boolean> =>
    pathExists(join(prorootLibDir, "libproroot.so"));

  const pkgAvailable = async (): Promise<boolean> => {
    try {
      await runHostCommand("sh", ["-c", "command -v pkg"], undefined, true);
      return true;
    } catch {
      return false;
    }
  };

  const installProrootLibs = async (
    dest: string,
    onProgress: ProgressSink,
  ): Promise<void> => {
    const base = env.PIX_PROROOT_LIBS_BASE_URL ?? PROROOT_LIBS_BASE_URL;
    await mkdir(dest, { recursive: true });
    let done = 0;
    for (const entry of PROROOT_LIBS) {
      const target = join(dest, entry.file);
      // Already present with a matching digest -> skip (idempotent).
      if (await pathExists(target)) {
        try {
          const existing = await sha256File(target);
          if (existing === entry.sha256) {
            done += 1;
            continue;
          }
        } catch {
          /* fall through and rewrite */
        }
      }
      const url = `${base}/${entry.file}`;
      const tmp = `${target}.part`;
      onProgress?.({
        stage: `download libproroot ${entry.file}`,
        percent: 8 + Math.floor((done / PROROOT_LIBS.length) * 80),
      });
      await downloadFile(url, tmp, entry.sha256);
      await rename(tmp, target);
      done += 1;
    }
    onProgress?.({ stage: "libproroot ready", percent: 90 });
  };

  const downloadRootfs = async (
    dest: string,
    onProgress: ProgressSink,
  ): Promise<{ rootfsSize?: number; sha256?: string }> => {
    const url = env.PIX_PROROOT_ROOTFS_URL ?? DEFAULT_PROROOT_ROOTFS_URL;
    const expectedSha =
      env.PIX_PROROOT_ROOTFS_SHA256 ?? DEFAULT_PROROOT_ROOTFS_SHA256;
    onProgress({ stage: "downloading rootfs", percent: 15 });
    const tmp = join(layout.proroot.libDir, "rootfs.tar.xz.part");
    await mkdir(layout.proroot.libDir, { recursive: true });
    const { total: rootfsBytes } = await downloadFile(
      url,
      tmp,
      expectedSha,
      (pct) => onProgress({ stage: "downloading rootfs", percent: pct }),
      env.PIX_PROROOT_ROOTFS_DISABLE_SHA === "1",
    );
    onProgress({ stage: "extracting rootfs", percent: 72 });
    // toybox tar (Android) ships gzip via zlib; xz support is unreliable, so
    // the default format follows the source (xz; PIX_PROROOT_ROOTFS_FORMAT to
    // override e.g. `gz` for alternative mirrors). Strip applies when a mirror
    // packs a leading version dir.
    const format = env.PIX_PROROOT_ROOTFS_FORMAT ?? DEFAULT_PROROOT_ROOTFS_FORMAT;
    const flag = format === "xz" ? "-xJf" : "-xzf";
    const strip = Number(env.PIX_PROROOT_ROOTFS_STRIP ?? DEFAULT_PROROOT_ROOTFS_STRIP);
    const args = [flag, tmp, "-C", dest];
    if (strip > 0) args.push("--strip-components", String(strip));
    await runHostCommand("tar", args);
    onProgress({ stage: "done", percent: 100 });
    return { rootfsSize: rootfsBytes || undefined, sha256: expectedSha || undefined };
  };

  return {
    prorootLibAvailable,
    pkgAvailable,
    installProrootLibs,
    downloadRootfs,
    run: (cmd, args) => runHostCommand(cmd, args, undefined, false),
  };
}

async function sha256File(file: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function downloadFile(
  url: string,
  tmp: string,
  expectedSha?: string,
  onProgress?: (percent: number) => void,
  skipSha = false,
): Promise<{ total: number }> {
  const hash = createHash("sha256");
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok || resp.body === null) {
    throw new RuntimeInstallError("download_failed");
  }
  const total = Number(resp.headers.get("content-length") ?? 0);
  let received = 0;
  const hashStream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const raw = Readable.fromWeb(resp.body as never);
  raw.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0 && received % 512_000 === 0) {
      onProgress?.(15 + Math.min(55, Math.floor((received / total) * 55)));
    }
  });
  await mkdir(dirname(tmp), { recursive: true });
  await pipeline(raw, hashStream, createWriteStream(tmp));
  const sha = hash.digest("hex");
  if (!skipSha && expectedSha && expectedSha !== sha) {
    throw new RuntimeInstallError("download_sha256_mismatch");
  }
  return { total };
}

function runHostCommand(
  cmd: string,
  args: string[],
  _onProgress?: ProgressSink,
  quiet = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: quiet ? "ignore" : ["ignore", "inherit", "inherit"],
    });
    child.on("error", () =>
      reject(new RuntimeInstallError(`command_not_found:${cmd}`)),
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new RuntimeInstallError(`command_failed:${cmd}`));
    });
  });
}
