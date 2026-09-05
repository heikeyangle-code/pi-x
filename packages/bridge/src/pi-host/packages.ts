/**
 * Pi Packages surface — npm/git/local package management for extensions,
 * skills, prompt templates and themes (docs/ENGINE-UI-SURFACES §2 / §6.1).
 *
 * 1:1 with the engine's own `core/package-manager.ts` + `utils/git.ts` +
 * `core/pi-manifest.ts` (pi 0.85.x):
 *   - `parseSource` order: `npm:` prefix → local path check → git URL → local;
 *   - npm packages install into `~/.pi/agent/npm` / `<cwd>/.pi/npm`
 *     (`npm install <spec> --prefix <root> --legacy-peer-deps`);
 *   - git packages clone into `~/.pi/agent/git/<host>/<path>` /
 *     `<cwd>/.pi/git/<host>/<path>`, refs are checked out after clone, and
 *     dependencies install with `npm install --omit=dev`;
 *   - the source is persisted into `settings.json` `packages[]` (user scope)
 *     or `<cwd>/.pi/settings.json` `packages[]` (project scope), deduped by
 *     package identity (`npm:<name>` / `git:<host>/<path>` / `local:<resolved>`)
 *     and replaced in place when the stored form differs;
 *   - `update` skips pinned (exact-version) npm sources and re-fetches git
 *     packages (pinned ref → fetch + hard-reset to the ref; unpinned → fetch
 *     default branch + hard-reset to origin/HEAD), then reinstalls deps.
 *
 * The App layer only manages the source list + installed artifacts; it never
 * interprets package internals (the engine owns resource discovery).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { SettingsFile, piAgentFiles } from "./surfaces.js";

const NETWORK_TIMEOUT_MS = 10_000;

export type PackageScope = "user" | "project";
export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface NpmSource {
  type: "npm";
  spec: string;
  name: string;
  version?: string;
  pinned: boolean;
}

export interface GitSource {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
}

export interface LocalSource {
  type: "local";
  path: string;
}

export type ParsedSource = NpmSource | GitSource | LocalSource;

/** Configured package entry as stored in `settings.json` packages[]. */
export type ConfiguredPackageEntry = string | { source: string };

export interface PiPackageInfo {
  source: string;
  scope: PackageScope;
  /** True when the settings entry is an object (pattern-filtered package). */
  filtered: boolean;
  type: "npm" | "git" | "local";
  /** Absolute install dir, when the package is actually installed. */
  installedPath?: string;
  /** package.json name at the install dir (npm/git). */
  displayName?: string;
  /** package.json version at the install dir (npm/git). */
  version?: string;
  /** Resource types declared in the package.json `pi` manifest. */
  resourceTypes: ResourceType[];
}

export interface PackageListOptions {
  /** Include uninstalled configured packages (default true). */
  includeMissing?: boolean;
}

/** Injectable command runner; the default spawns npm/git on the host. */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<string>;

export function defaultRunner(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`command_timeout:${cmd}`));
          }, opts.timeoutMs);
    child.on("error", (err) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new Error(`command_not_found:${cmd} (${err.message})`));
    });
    child.on("exit", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(
          new Error(
            `command_failed:${cmd} ${args.join(" ")} (exit ${code ?? "?"})${
              stderr ? `: ${stderr.trim().slice(0, 400)}` : ""
            }`,
          ),
        );
      }
    });
  });
}

/** Mirror `parseNpmSpec` in package-manager.ts (handles scoped packages). */
function parseNpmSpec(spec: string): { name: string; version?: string } {
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  if (!match) {
    return { name: spec };
  }
  return { name: match[1] ?? spec, version: match[2] };
}

/** Mirror semver `valid()`: a complete exact version, no ranges allowed. */
function isExactNpmVersion(version: string | undefined): boolean {
  if (!version) return false;
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  );
}

/**
 * Mirror `isLocalPath` (utils/paths.ts): anything that does not carry a known
 * remote prefix is treated as a local path. `file:` URLs are local.
 */
function isLocalPath(source: string): boolean {
  const trimmed = source.trim();
  if (
    trimmed.startsWith("npm:") ||
    trimmed.startsWith("git:") ||
    trimmed.startsWith("github:") ||
    trimmed.startsWith("http:") ||
    trimmed.startsWith("https:") ||
    trimmed.startsWith("ssh:")
  ) {
    return false;
  }
  return true;
}

/**
 * Mirror `parseGitUrl` (utils/git.ts) without the hosted-git-info dependency:
 * with the `git:` prefix accept shorthand forms (`host/path`, scp-like,
 * `github:user/repo`); without it, only explicit protocol URLs. `#ref`
 * suffixes split into `ref`.
 */
function parseGitUrl(source: string): GitSource | null {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
    return null;
  }

  let repo = url;
  let ref: string | undefined;
  const hashIdx = url.indexOf("#");
  if (hashIdx >= 0) {
    repo = url.slice(0, hashIdx);
    ref = url.slice(hashIdx + 1) || undefined;
  }

  // `github:user/repo` shorthand — only accepted under the `git:` prefix
  // (without it the early-return guard above already rejected it, mirroring pi).
  const githubShorthand = repo.match(/^github:([^/]+\/[^/#@]+)(?:@(.+))?$/);
  if (githubShorthand && hasGitPrefix) {
    const repoPath = githubShorthand[1] ?? "";
    const atRef = githubShorthand[2];
    if (repoPath) {
      return buildGitSource({
        repo: `https://github.com/${repoPath}`,
        host: "github.com",
        path: repoPath.replace(/\.git$/, ""),
        ref: atRef ?? ref,
      });
    }
  }

  // `git@host:path` scp-like shorthand.
  const scpLikeMatch = repo.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    return buildGitSource({
      repo,
      host: scpLikeMatch[1] ?? "",
      path: (scpLikeMatch[2] ?? "").replace(/\/+$/, ""),
      ref,
    });
  }

  let host = "";
  let path = "";
  if (/^(https?|ssh|git):\/\//i.test(repo)) {
    try {
      const parsed = new URL(repo);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else if (hasGitPrefix) {
    const slashIndex = repo.indexOf("/");
    if (slashIndex < 0) return null;
    host = repo.slice(0, slashIndex);
    path = repo.slice(slashIndex + 1);
    if (!host.includes(".") && host !== "localhost") return null;
    repo = `https://${repo}`;
  } else {
    return null;
  }
  if (!host || !path) return null;
  return buildGitSource({ repo, host, path: path.replace(/\/+$/, ""), ref });
}

function buildGitSource(args: { repo: string; host: string; path: string; ref?: string }): GitSource | null {
  if (!args.host || !args.path) return null;
  return {
    type: "git",
    repo: args.repo,
    host: args.host,
    path: args.path.replace(/\.git$/, ""),
    ref: args.ref || undefined,
  };
}

/** Mirror `parseSource` in package-manager.ts. */
export function parsePackageSource(source: string): ParsedSource {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const { name, version } = parseNpmSpec(spec);
    return {
      type: "npm",
      spec,
      name,
      version,
      pinned: isExactNpmVersion(version),
    };
  }
  if (isLocalPath(source)) {
    return { type: "local", path: source };
  }
  const gitParsed = parseGitUrl(source);
  if (gitParsed) return gitParsed;
  return { type: "local", path: source };
}

/** Mirror `getBaseDirForScope`: user → agentDir, project → cwd/.pi. */
function baseDirForScope(cwd: string, piHome: string, scope: PackageScope): string {
  return scope === "project" ? join(cwd, ".pi") : piAgentFiles(piHome).agent;
}

/** Mirror `getSourceMatchKeyForInput` / `getPackageIdentity`. */
export function piPackageIdentity(source: string, cwd = ""): string {
  const parsed = parsePackageSource(source);
  if (parsed.type === "npm") return `npm:${parsed.name}`;
  if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
  return `local:${resolve(cwd, parsed.path)}`;
}

export function npmInstallRoot(cwd: string, piHome: string, scope: PackageScope): string {
  return scope === "project" ? join(cwd, ".pi", "npm") : join(piAgentFiles(piHome).agent, "npm");
}

export function gitInstallRoot(cwd: string, piHome: string, scope: PackageScope): string {
  return scope === "project" ? join(cwd, ".pi", "git") : join(piAgentFiles(piHome).agent, "git");
}

export function gitInstallPath(source: GitSource, cwd: string, piHome: string, scope: PackageScope): string {
  return join(gitInstallRoot(cwd, piHome, scope), source.host, source.path);
}

export function npmInstallPath(source: NpmSource, cwd: string, piHome: string, scope: PackageScope): string {
  return join(npmInstallRoot(cwd, piHome, scope), "node_modules", source.name);
}

function settingsFile(cwd: string, piHome: string, scope: PackageScope): SettingsFile {
  const files = piAgentFiles(piHome);
  return new SettingsFile(scope === "project" ? join(cwd, ".pi", "settings.json") : files.settings);
}

function asPackageEntries(value: unknown): ConfiguredPackageEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ConfiguredPackageEntry =>
      typeof entry === "string" ||
      (typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string"),
  );
}

function entrySource(entry: ConfiguredPackageEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

/** Read `package.json` at an install dir: name/version + `pi` manifest
 * (1:1 with `readPiManifest`). */
function readPackageMeta(dir: string): {
  displayName?: string;
  version?: string;
  resourceTypes: ResourceType[];
} {
  const out: { displayName?: string; version?: string; resourceTypes: ResourceType[] } = {
    resourceTypes: [],
  };
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      pi?: unknown;
    };
    if (typeof pkg.name === "string") out.displayName = pkg.name;
    if (typeof pkg.version === "string") out.version = pkg.version;
    const manifest = pkg.pi;
    if (manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)) {
      for (const field of ["extensions", "skills", "prompts", "themes"] as const) {
        const entries = (manifest as Record<string, unknown>)[field];
        if (Array.isArray(entries) && entries.every((e) => typeof e === "string")) {
          out.resourceTypes.push(field);
        }
      }
    }
  } catch {
    // unreadable package.json — the package is still listed by source
  }
  return out;
}

/** Install dir of a configured source for a scope, when present on disk.
 * Mirrors `getInstalledPath` (local resolves from the scope base dir; npm
 * falls back to the legacy global root for user scope). */
async function installedPathFor(
  parsed: ParsedSource,
  cwd: string,
  piHome: string,
  scope: PackageScope,
  run: CommandRunner,
): Promise<string | undefined> {
  let candidate: string | undefined;
  if (parsed.type === "npm") {
    candidate = npmInstallPath(parsed, cwd, piHome, scope);
    if (scope === "user" && !existsSync(candidate)) {
      // legacy global npm root fallback (pi `getLegacyGlobalNpmInstallPath`)
      try {
        const globalRoot = (await run("npm", ["root", "-g"])).trim();
        candidate = join(globalRoot, parsed.name);
      } catch {
        candidate = undefined;
      }
    }
  } else if (parsed.type === "git") {
    candidate = gitInstallPath(parsed, cwd, piHome, scope);
  } else {
    candidate = resolve(baseDirForScope(cwd, piHome, scope), parsed.path);
  }
  return candidate !== undefined && existsSync(candidate) ? candidate : undefined;
}

/** `pi list` equivalent: configured packages from project + user settings,
 * enriched with install state and package.json metadata. */
export async function listPiPackages(
  cwd: string,
  piHome: string,
  opts: PackageListOptions = {},
  run: CommandRunner = defaultRunner,
): Promise<PiPackageInfo[]> {
  const includeMissing = opts.includeMissing ?? true;
  const out: PiPackageInfo[] = [];
  const scopes: PackageScope[] = ["project", "user"];
  for (const scope of scopes) {
    const settings = await settingsFile(cwd, piHome, scope).load();
    for (const entry of asPackageEntries(settings["packages"])) {
      const source = entrySource(entry);
      const parsed = parsePackageSource(source);
      const installedPath = await installedPathFor(parsed, cwd, piHome, scope, run);
      if (!includeMissing && installedPath === undefined) continue;
      const meta = installedPath ? readPackageMeta(installedPath) : undefined;
      out.push({
        source,
        scope,
        filtered: typeof entry === "object",
        type: parsed.type,
        installedPath,
        displayName: meta?.displayName,
        version: meta?.version,
        resourceTypes: meta?.resourceTypes ?? [],
      });
    }
  }
  return out;
}

/**
 * Mirror `addSourceToSettings`/`removeSourceFromSettings`: dedupe by package
 * identity; a matching entry is replaced in place when the stored form differs
 * (e.g. bare name → `npm:`-prefixed), otherwise nothing is written.
 * Local sources are normalized to a path relative to the scope base dir.
 */
export async function persistPackageSource(
  cwd: string,
  piHome: string,
  scope: PackageScope,
  source: string,
  remove: boolean,
): Promise<boolean> {
  const file = settingsFile(cwd, piHome, scope);
  const current = await file.load();
  const entries = asPackageEntries(current["packages"]);
  const baseDir = baseDirForScope(cwd, piHome, scope);
  const matches = (entry: ConfiguredPackageEntry): boolean =>
    piPackageIdentity(entrySource(entry), cwd) === piPackageIdentity(source, cwd);

  if (remove) {
    const next = entries.filter((entry) => !matches(entry));
    if (next.length === entries.length) return false;
    await file.update({ packages: next });
    return true;
  }

  // Normalize local sources to a scope-relative path (1:1 normalizePackageSourceForSettings).
  let normalized = source;
  if (parsePackageSource(source).type === "local") {
    const resolved = resolve(cwd, source);
    const rel = relative(baseDir, resolved);
    normalized = rel || ".";
  }

  const index = entries.findIndex(matches);
  if (index === -1) {
    await file.update({ packages: [...entries, normalized] });
    return true;
  }
  const existing = entries[index];
  if (entrySource(existing) === normalized) return false;
  const next = [...entries];
  next[index] = typeof existing === "string" ? normalized : { ...existing, source: normalized };
  await file.update({ packages: next });
  return true;
}

function ensureNpmProject(root: string): void {
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    writeFileSync(packageJsonPath, JSON.stringify({ name: "pi-extensions", private: true }, null, 2), "utf8");
  }
  const ignorePath = join(root, ".gitignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, "*\n!.gitignore\n", "utf8");
  }
}

function npmArgs(kind: "install" | "uninstall", root: string, spec: string, name?: string): string[] {
  if (kind === "install") {
    return ["install", spec, "--prefix", root, "--legacy-peer-deps"];
  }
  return ["uninstall", name ?? spec, "--prefix", root, "--legacy-peer-deps"];
}

export interface InstallOptions {
  local?: boolean;
  run?: CommandRunner;
}

/** Mirror `installGit`'s dependency install: `npm install --omit=dev`. */
async function installGitDependencies(target: string, run: CommandRunner): Promise<void> {
  if (existsSync(join(target, "package.json"))) {
    await run("npm", ["install", "--omit=dev"], { cwd: target, timeoutMs: NETWORK_TIMEOUT_MS });
  }
}

/** Mirror `ensureGitRef`'s refresh: fetch the target ref, hard-reset, clean
 * untracked files (extensions should be pristine), reinstall deps. */
async function ensureGitRef(target: string, ref: string, run: CommandRunner): Promise<void> {
  await run("git", ["fetch", "--prune", "--no-tags", "origin", `+${ref}`], {
    cwd: target,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  await run("git", ["reset", "--hard", ref], { cwd: target, timeoutMs: NETWORK_TIMEOUT_MS });
  await run("git", ["clean", "-fdx"], { cwd: target, timeoutMs: NETWORK_TIMEOUT_MS }).catch(() => {});
  await installGitDependencies(target, run);
}

/** Update an existing git clone to the configured ref, or to the remote's
 * default branch when unpinned (mirror `updateGit` + `getLocalGitUpdateTarget`). */
async function updateGitSource(parsed: GitSource, target: string, run: CommandRunner): Promise<void> {
  if (parsed.ref) {
    await ensureGitRef(target, `refs/heads/${parsed.ref}`, run);
    return;
  }
  await run("git", ["remote", "set-head", "origin", "-a"], { cwd: target, timeoutMs: NETWORK_TIMEOUT_MS }).catch(
    () => {},
  );
  await ensureGitRef(target, "refs/remotes/origin/HEAD", run);
}

/** Prune now-empty parent dirs after a git removal (mirror `pruneEmptyGitParents`). */
async function pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): Promise<void> {
  if (!installRoot) return;
  const resolvedRoot = resolve(installRoot);
  let current = dirname(targetDir);
  while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
    if (!existsSync(current)) {
      current = dirname(current);
      continue;
    }
    const entries = readdirSync(current);
    if (entries.length > 0) break;
    try {
      await rm(current, { recursive: true, force: true });
    } catch {
      break;
    }
    current = dirname(current);
  }
}

/** `pi install <source> [-l]` — install artifacts then persist to settings
 * (mirror `installAndPersist`). */
export async function installPiPackage(
  cwd: string,
  piHome: string,
  source: string,
  opts: InstallOptions = {},
): Promise<{ installed: boolean; installedPath?: string }> {
  const run = opts.run ?? defaultRunner;
  const scope: PackageScope = opts.local ? "project" : "user";
  const parsed = parsePackageSource(source);
  let installedPath: string | undefined;
  if (parsed.type === "npm") {
    const root = npmInstallRoot(cwd, piHome, scope);
    ensureNpmProject(root);
    await run("npm", npmArgs("install", root, parsed.spec), { timeoutMs: NETWORK_TIMEOUT_MS });
    installedPath = npmInstallPath(parsed, cwd, piHome, scope);
  } else if (parsed.type === "git") {
    const target = gitInstallPath(parsed, cwd, piHome, scope);
    if (existsSync(target)) {
      // Mirror installGit: an existing clone is refreshed to the configured ref.
      await updateGitSource(parsed, target, run);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await run("git", ["clone", parsed.repo, target], { timeoutMs: NETWORK_TIMEOUT_MS });
      if (parsed.ref) {
        await run("git", ["checkout", parsed.ref], { cwd: target, timeoutMs: NETWORK_TIMEOUT_MS });
      }
      await installGitDependencies(target, run);
    }
    installedPath = target;
  } else {
    const resolved = resolve(cwd, parsed.path);
    if (!existsSync(resolved)) {
      throw new Error(`Path does not exist: ${resolved}`);
    }
    installedPath = resolved;
  }
  await persistPackageSource(cwd, piHome, scope, source, false);
  return { installed: true, installedPath };
}

/** `pi remove <source> [-l]` — uninstall artifacts then drop the setting
 * (mirror `removeAndPersist`). */
export async function removePiPackage(
  cwd: string,
  piHome: string,
  source: string,
  opts: InstallOptions = {},
): Promise<{ removed: boolean }> {
  const run = opts.run ?? defaultRunner;
  const scope: PackageScope = opts.local ? "project" : "user";
  const parsed = parsePackageSource(source);
  if (parsed.type === "npm") {
    const root = npmInstallRoot(cwd, piHome, scope);
    if (existsSync(root)) {
      await run("npm", npmArgs("uninstall", root, parsed.spec, parsed.name), {
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
    }
  } else if (parsed.type === "git") {
    const target = gitInstallPath(parsed, cwd, piHome, scope);
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
      await pruneEmptyGitParents(target, gitInstallRoot(cwd, piHome, scope));
    }
  }
  const removed = await persistPackageSource(cwd, piHome, scope, source, true);
  return { removed };
}

/** `pi update [source]` — re-resolve unpinned npm specs and pull git packages.
 * Pinned npm versions are fixed and skipped (mirror `updateConfiguredSources`). */
export async function updatePiPackages(
  cwd: string,
  piHome: string,
  source?: string,
  opts: InstallOptions = {},
): Promise<{ updated: string[] }> {
  const run = opts.run ?? defaultRunner;
  const updated: string[] = [];
  const identity = source ? piPackageIdentity(source, cwd) : undefined;
  for (const scope of ["project", "user"] as const) {
    const settings = await settingsFile(cwd, piHome, scope).load();
    for (const entry of asPackageEntries(settings["packages"])) {
      const entrySourceStr = entrySource(entry);
      if (identity !== undefined && piPackageIdentity(entrySourceStr, cwd) !== identity) continue;
      const parsed = parsePackageSource(entrySourceStr);
      if (parsed.type === "npm") {
        if (parsed.pinned) continue;
        const root = npmInstallRoot(cwd, piHome, scope);
        if (existsSync(root)) {
          await run("npm", npmArgs("install", root, parsed.spec), {
            timeoutMs: NETWORK_TIMEOUT_MS,
          });
        }
        updated.push(entrySourceStr);
      } else if (parsed.type === "git") {
        const target = gitInstallPath(parsed, cwd, piHome, scope);
        if (!existsSync(target)) {
          await installPiPackage(cwd, piHome, entrySourceStr, { local: scope === "project", run });
          updated.push(entrySourceStr);
          continue;
        }
        await updateGitSource(parsed, target, run);
        updated.push(entrySourceStr);
      }
    }
  }
  return { updated };
}
