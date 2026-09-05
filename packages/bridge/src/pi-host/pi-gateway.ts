/**
 * Pi Gateway — thin passthrough between the app client and pi engines.
 *
 * End-state wire design (docs/ENGINE-INTEGRATION.md §6): the app consumes the
 * pi event model 1:1. This gateway:
 *   - wraps every engine frame in an envelope {engineVersion, protocolVersion}
 *     so clients can do forward-compatible version handling;
 *   - forwards client control messages to the right project engine (prompt,
 *     steer, abort, get_state, ...) with request/response correlation;
 *   - keeps filesystem-ish ops (diff, directory listing) out of scope (they
 *     stay on the bridge FS layer).
 *
 * Transport-agnostic: `send` is provided by the caller (websocket adapter).
 */

import { EnginePool } from "./engine-pool.js";
import type { EngineEvent } from "./engine-process.js";
import * as rpc from "./pi-rpc.js";
import { PixConfigFile, type PixConfig } from "./pix-config.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SettingsFile,
  ModelsFile,
  listResourceDirs,
  listSkillInfos,
  listExtensionInfos,
  listPromptTemplates,
  sanitizeTemplateName,
  writePromptTemplate,
  deletePromptTemplate,
  readSkillMarkdown,
  looksLikeSkillMarkdown,
  piAgentFiles,
  type CustomProviderSpec,
  type CustomModelSpec,
  type SkillRoot,
} from "./surfaces.js";
import type { RuntimeRoute } from "./pix-config.js";
import type { RuntimeInstallProgress } from "./runtime-manager.js";

export const PI_WIRE_PROTOCOL_VERSION = 1;
/** Default pi home; overridable for tests via PiGatewayOptions.piHome. */
const DEFAULT_PI_HOME = process.env.PI_HOME ?? (process.env.HOME ?? "");

/** Runtime installation status reported by the host (docs/ENGINE-BUNDLE.md). */
export interface RuntimeStatus {
  route: RuntimeRoute;
  prorootInstalled: boolean;
  prootDistroInstalled: boolean;
  /** Size of the downloaded rootfs in bytes, when present. */
  rootfsSize?: number;
  /** Packages installed in the active environment, when enumerable. */
  installedPackages?: string[];
  /** Routes the host can switch to (installable ones included). */
  available: RuntimeRoute[];
}

export interface PiFrameEnvelope {
  kind: "pi";
  engineVersion: string;
  protocolVersion: number;
  /** Engine version of the event/frame schema. */
  frame: unknown;
}

export interface ClientControlMessage {
  id?: string;
  type: "control";
  op: string;
  /** Project (workspace) the message targets. */
  projectId: string;
  payload?: Record<string, unknown>;
}

export interface PiGatewayOptions {
  piEntry: string;
  engineVersion: string;
  protocolVersion?: number;
  maxIdleMs?: number;
  env?: Record<string, string>;
  /** pi home root (~). Defaults to PI_HOME/HOME. */
  piHome?: string;
  /** Resolve the cwd (filesystem path) for a project id. */
  resolveCwd: (projectId: string) => string;
  /**
   * Wrapper prefix for the engine command (route B runtimes). Fixed argv list
   * or a per-cwd resolver (may be async); see EnginePoolOptions.commandPrefix.
   */
  commandPrefix?:
    | string[]
    | ((cwd: string) => string[] | undefined | Promise<string[] | undefined>);
  /** Host probe for runtime install status (get_runtime_status). */
  runtimeStatus?: () => Promise<RuntimeStatus | undefined>;
  /** Host-triggered install of a route B runtime (runtime_install). */
  runtimeInstall?: (
    route: RuntimeRoute,
    onProgress?: (progress: RuntimeInstallProgress) => void,
  ) => Promise<{ success: boolean; error?: string }>;
}

export class PiGateway {
  private readonly pool: EnginePool;
  private readonly opts: PiGatewayOptions;
  private readonly protocolVersion: number;
  /** pi home root (~); sessions/settings live under ~/.pi/agent. */
  readonly piHome: string;

  constructor(opts: PiGatewayOptions) {
    this.opts = opts;
    this.protocolVersion = opts.protocolVersion ?? PI_WIRE_PROTOCOL_VERSION;
    this.piHome = opts.piHome ?? DEFAULT_PI_HOME;
    this.pool = new EnginePool({
      piEntry: opts.piEntry,
      maxIdleMs: opts.maxIdleMs,
      env: opts.env,
      commandPrefix: opts.commandPrefix,
      onEvent: (projectId, event) => this.emit(projectId, event),
      onUiRequest: (projectId, request, respond) => {
        const id = String((request as Record<string, unknown>)["id"] ?? "ui");
        this.pendingUi.set(id, respond);
        // Spread the request so id/method/title land top-level (aligned with
        // cc-adapter's permission_request mapping the app UI already renders).
        this.emit(projectId, {
          type: "extension_ui_request",
          projectId,
          ...(request as Record<string, unknown>),
        });
      },
      onExit: (projectId, code, signal) =>
        this.emit(projectId, { type: "engine_exit", projectId, code, signal }),
    });
  }

  /** Wire sink installed by the transport adapter. */
  send?: (envelope: PiFrameEnvelope) => void;

  private readonly pendingUi = new Map<string, (value: unknown) => void>();

  /** Answer a previously emitted extension_ui_request by its id. */
  respondUi(requestId: string, value: unknown): boolean {
    const respond = this.pendingUi.get(requestId);
    if (respond === undefined) return false;
    this.pendingUi.delete(requestId);
    respond(value);
    return true;
  }

  private emit(projectId: string, frame: unknown): void {
    this.send?.({
      kind: "pi",
      engineVersion: this.opts.engineVersion,
      protocolVersion: this.protocolVersion,
      frame: { projectId, ...(frame as Record<string, unknown>) },
    });
  }

  /** Launch-time engine argv (from ~/.pi/agent/pix-config.json), if any. */
  private async resolveEngineArgs(): Promise<string[] | undefined> {
    const files = piAgentFiles(this.piHome);
    const cfg = await new PixConfigFile(files.pixConfig).load();
    return cfg.engineArgs;
  }

  /** Handle one client control message; resolves with the engine response. */
  async handleControl(msg: ClientControlMessage): Promise<unknown> {
    // restart_engine applies launch-time configuration changes (engineArgs,
    // SYSTEM.md / APPEND_SYSTEM.md): stop the current engine so the next
    // request respawns it with the new argv/files. Must not require the
    // engine to be running.
    if (msg.op === "restart_engine") {
      await this.pool.stop(msg.projectId);
      return { success: true, restarted: true };
    }
    const cwd = this.opts.resolveCwd(msg.projectId);
    const args = await this.resolveEngineArgs();
    const engine = await this.pool.getOrStart(msg.projectId, cwd, 1, args);
    const payload = msg.payload ?? {};

    switch (msg.op) {
      case "prompt":
        return rpc.prompt(engine, {
          message: String(payload.message ?? ""),
          streamingBehavior: payload.streamingBehavior as
            | "steer"
            | "followUp"
            | undefined,
        });
      case "steer":
        return rpc.steer(engine, String(payload.message ?? ""));
      case "follow_up":
        return rpc.followUp(engine, String(payload.message ?? ""));
      case "abort":
        return rpc.abort(engine);
      case "get_state":
        return rpc.getState(engine);
      case "get_commands":
        return rpc.getCommands(engine);
      case "set_model":
        return rpc.setModel(
          engine,
          String(payload.provider ?? ""),
          String(payload.modelId ?? ""),
        );
      case "get_available_models":
        return rpc.getAvailableModels(engine);
      case "set_thinking_level":
        return rpc.setThinkingLevel(engine, payload.level as string | number);
      case "get_tree":
        return rpc.getSessionTree(engine);
      case "fork":
        return rpc.forkSession(engine, payload);
      case "switch_session":
        return rpc.switchSession(engine, String(payload.sessionPath ?? ""));
      case "get_session_stats":
        return rpc.getSessionStats(engine);
      case "get_messages":
        return rpc.getMessages(engine);
      case "compact":
        return rpc.compact(
          engine,
          payload.customInstructions === undefined
            ? undefined
            : String(payload.customInstructions),
        );
      // ---- session / model / mode surface (pi --mode rpc) ----
      case "new_session":
        return engine.request({
          type: "new_session",
          ...(payload.parentSession === undefined
            ? {}
            : { parentSession: String(payload.parentSession) }),
        });
      case "cycle_model":
        return engine.request({ type: "cycle_model" });
      case "get_available_thinking_levels":
        return engine.request({ type: "get_available_thinking_levels" });
      case "cycle_thinking_level":
        return engine.request({ type: "cycle_thinking_level" });
      case "set_steering_mode":
        return engine.request({
          type: "set_steering_mode",
          mode: String(payload.mode ?? "one-at-a-time"),
        });
      case "set_follow_up_mode":
        return engine.request({
          type: "set_follow_up_mode",
          mode: String(payload.mode ?? "one-at-a-time"),
        });
      case "set_auto_compaction":
        return engine.request({
          type: "set_auto_compaction",
          enabled: payload.enabled === true,
        });
      case "set_auto_retry":
        return engine.request({
          type: "set_auto_retry",
          enabled: payload.enabled === true,
        });
      case "abort_retry":
        return engine.request({ type: "abort_retry" });
      case "clear_queue":
        return engine.request({ type: "clear_queue" });
      case "set_session_name":
        return engine.request({ type: "set_session_name", name: String(payload.name ?? "") });
      case "export_html":
        return engine.request({
          type: "export_html",
          ...(payload.outputPath === undefined ? {} : { outputPath: String(payload.outputPath) }),
        });
      case "clone":
        return engine.request({ type: "clone" });
      case "get_fork_messages":
        return engine.request({ type: "get_fork_messages" });
      case "get_entries":
        return engine.request({
          type: "get_entries",
          ...(payload.since === undefined ? {} : { since: String(payload.since) }),
        });
      case "get_last_assistant_text":
        return engine.request({ type: "get_last_assistant_text" });
      case "bash": {
        const response = await rpc.runBash(
          engine,
          String(payload.command ?? ""),
          msg.id,
        );
        return response;
      }
      case "abort_bash":
        return rpc.abortBash(engine);
      case "stop":
        await this.pool.stop(msg.projectId);
        return { stopped: true };
      // ---- pi surface files (settings/models/skills) — support Pi X UI ----
      case "get_settings": {
        const files = piAgentFiles(this.piHome);
        const data = await new SettingsFile(files.settings).load();
        return { success: true, data };
      }
      case "update_settings": {
        const files = piAgentFiles(this.piHome);
        const settings = new SettingsFile(files.settings);
        await settings.update((payload.patch as Record<string, unknown>) ?? {});
        return { success: true, data: await settings.load() };
      }
      case "get_models": {
        const files = piAgentFiles(this.piHome);
        const providers = await new ModelsFile(files.models).loadProviders();
        return { success: true, data: providers };
      }
      case "upsert_model": {
        const files = piAgentFiles(this.piHome);
        const models = new ModelsFile(files.models);
        const providerId = String(payload.providerId ?? "");
        const spec = (payload.spec ?? {}) as CustomProviderSpec;
        await models.upsertProvider(providerId, spec);
        return { success: true, data: await models.loadProviders() };
      }
      case "remove_model": {
        const files = piAgentFiles(this.piHome);
        const models = new ModelsFile(files.models);
        const providerId = String(payload.providerId ?? "");
        const removed = await models.removeProvider(providerId);
        return { success: true, removed };
      }
      case "add_model": {
        const files = piAgentFiles(this.piHome);
        const models = new ModelsFile(files.models);
        const providerId = String(payload.providerId ?? "");
        const model = (payload.model ?? {}) as CustomModelSpec;
        await models.addModel(providerId, model);
        return { success: true, data: await models.loadProviders() };
      }
      case "list_skills": {
        const files = piAgentFiles(this.piHome);
        const roots: SkillRoot[] = [
          { scope: "global", dir: files.skillsDir },
          { scope: "project", dir: join(cwd, ".pi", "skills") },
        ];
        return { success: true, data: await listSkillInfos(roots) };
      }
      case "read_skill": {
        const scope = payload.scope === "project" ? "project" : "global";
        const name = String(payload.name ?? "");
        // Guard the path join: names come from the app listing, but never allow
        // traversal into arbitrary dirs.
        if (
          !name ||
          name.includes("/") ||
          name.includes("\\") ||
          name === ".." ||
          name.includes("..")
        ) {
          return { success: false, error: "invalid_skill_name" };
        }
        const files = piAgentFiles(this.piHome);
        const root = scope === "project" ? join(cwd, ".pi", "skills") : files.skillsDir;
        return {
          success: true,
          data: { name, scope, content: await readSkillMarkdown(join(root, name)) },
        };
      }
      case "list_extensions": {
        const files = piAgentFiles(this.piHome);
        // 1:1 with the engine's extension discovery (loader.ts): project-local
        // cwd/.pi/extensions/ first, then global ~/.pi/agent/extensions/.
        const roots: SkillRoot[] = [
          { scope: "project", dir: join(cwd, ".pi", "extensions") },
          { scope: "global", dir: files.extensionsDir },
        ];
        return { success: true, data: await listExtensionInfos(roots) };
      }
      case "looks_like_skill": {
        return { success: true, looksLikeSkill: looksLikeSkillMarkdown(String(payload.content ?? "")) };
      }
      // ---- prompt templates (official prompt-templates.ts semantics) ----
      case "list_prompt_templates": {
        return { success: true, data: await listPromptTemplates(cwd, this.piHome) };
      }
      case "read_prompt_template": {
        const scope = payload.scope === "project" ? "project" : "global";
        const name = sanitizeTemplateName(String(payload.name ?? ""));
        if (!name) return { success: false, error: "invalid_template_name" };
        const files = piAgentFiles(this.piHome);
        const dir = scope === "project" ? join(cwd, ".pi", "prompts") : files.agentPromptsDir;
        try {
          const content = await readFile(join(dir, name), "utf8");
          return { success: true, data: { name, scope, content } };
        } catch {
          return { success: false, error: "template_not_found" };
        }
      }
      case "write_prompt_template": {
        const scope = payload.scope === "project" ? "project" : "global";
        try {
          const file = await writePromptTemplate(
            cwd,
            this.piHome,
            scope,
            String(payload.name ?? ""),
            String(payload.content ?? ""),
          );
          return { success: true, data: { file } };
        } catch {
          return { success: false, error: "invalid_template_name" };
        }
      }
      case "delete_prompt_template": {
        const scope = payload.scope === "project" ? "project" : "global";
        try {
          const deleted = await deletePromptTemplate(
            cwd,
            this.piHome,
            scope,
            String(payload.name ?? ""),
          );
          return { success: true, data: { deleted } };
        } catch {
          return { success: false, error: "invalid_template_name" };
        }
      }
      // ---- Pi X config surface (engine launch args + prompt files) ----
      case "get_pix_config": {
        const files = piAgentFiles(this.piHome);
        const data = await new PixConfigFile(files.pixConfig).load();
        return { success: true, data };
      }
      case "update_pix_config": {
        const files = piAgentFiles(this.piHome);
        const data = await new PixConfigFile(files.pixConfig).update(
          (payload.patch as Partial<PixConfig> | undefined) ?? {},
        );
        return { success: true, data };
      }
      // ---- runtime route (docs/ENGINE-BUNDLE.md "路线切换 UI 落地") ----
      case "get_runtime_status": {
        const files = piAgentFiles(this.piHome);
        const cfg = await new PixConfigFile(files.pixConfig).load();
        const host = await this.opts.runtimeStatus?.().catch(() => undefined);
        const route: RuntimeRoute = cfg.runtimeRoute ?? "bionic";
        return {
          success: true,
          data: host ?? {
            route,
            prorootInstalled: false,
            prootDistroInstalled: false,
            available: ["bionic"],
          },
        };
      }
      case "set_runtime_route": {
        const next = String(payload.route ?? "");
        if (next !== "bionic" && next !== "proroot" && next !== "proot-distro") {
          return { success: false, error: "invalid_runtime_route" };
        }
        const files = piAgentFiles(this.piHome);
        const cfg = new PixConfigFile(files.pixConfig);
        const current = await cfg.load();
        if (current.runtimeRoute !== next) {
          await cfg.update({ runtimeRoute: next });
        }
        // Route changes apply at spawn time; restart the project engine so the
        // new runtime takes effect immediately (mirrors restart_engine).
        await this.pool.stop(msg.projectId);
        return { success: true, route: next, restarted: true };
      }
      case "runtime_install": {
        const route = String(payload.route ?? "");
        if (route !== "proroot" && route !== "proot-distro") {
          return { success: false, error: "invalid_runtime_route" };
        }
        if (this.opts.runtimeInstall === undefined) {
          return { success: false, error: "runtime_install_unavailable" };
        }
        const result = await this.opts.runtimeInstall(route, (progress) => {
          // Progress is streamed as events (docs: "进度经事件流回传").
          this.emit(msg.projectId, {
            type: "runtime_install_progress",
            projectId: msg.projectId,
            route,
            stage: progress.stage,
            percent: progress.percent,
          });
        });
        return { success: result.success, error: result.error };
      }
      case "read_prompt_files": {
        const files = piAgentFiles(this.piHome);
        const global = {
          systemPrompt: await readPromptFile(files.systemPrompt),
          appendSystemPrompt: await readPromptFile(files.appendSystemPrompt),
        };
        const project = {
          systemPrompt: await readPromptFile(join(cwd, ".pi", "SYSTEM.md")),
          appendSystemPrompt: await readPromptFile(join(cwd, ".pi", "APPEND_SYSTEM.md")),
        };
        return { success: true, data: { global, project } };
      }
      case "write_prompt_file": {
        const scope = payload.scope === "project" ? join(cwd, ".pi") : piAgentFiles(this.piHome).agent;
        const kind = payload.kind === "append" ? "APPEND_SYSTEM.md" : "SYSTEM.md";
        const file = join(scope, kind);
        await mkdir(scope, { recursive: true });
        await writeFile(file, String(payload.content ?? ""), "utf8");
        return { success: true, file };
      }
      default:
        return {
          type: "response",
          command: msg.op,
          success: false,
          error: `unsupported_op:${msg.op}`,
        };
    }
  }

  stopAll(): Promise<void> {
    return this.pool.stopAll();
  }
}

/** Read an optional text file; null when missing/unreadable. */
async function readPromptFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
