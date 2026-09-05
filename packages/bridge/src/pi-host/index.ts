/**
 * Pi Host — facade for engine integration (M2 wiring point).
 *
 * Combines: engine processes (per project), typed RPC commands, and the 1:1
 * surface files (settings/models/resources). The bridge websocket/session
 * layer plugs into these instead of talking to pi directly.
 */

export {
  EngineProcess,
  type EngineProcessOptions,
  type EngineRequest,
  type EngineResponse,
  type EngineEvent,
} from "./engine-process.js";
export { EnginePool } from "./engine-pool.js";
export {
  SettingsFile,
  ModelsFile,
  listResourceDirs,
  looksLikeSkillMarkdown,
  piAgentFiles,
  type CustomProviderApi,
  type CustomProviderSpec,
  type CustomModelSpec,
} from "./surfaces.js";
export * as rpc from "./pi-rpc.js";
export { PiGateway, PI_WIRE_PROTOCOL_VERSION, type PiFrameEnvelope, type ClientControlMessage } from "./pi-gateway.js";
export { PiAdapter, type PiGatewayLike, toServerMessage } from "./pi-adapter.js";
export {
  runtimeLayout,
  resolveRouteCommandPrefix,
  probeRuntimeStatus,
  installRuntime,
  createRuntimeHooks,
  RuntimeInstallError,
  type RuntimeInstallProgress,
  type ProgressSink,
  type RuntimeLayout,
  type RuntimeInstallHost,
  type RuntimeHooks,
  type InstallResult,
  PROROOT_LIBS_VERSION,
  PROROOT_LIBS_BASE_URL,
  PROROOT_LIBS,
  DEFAULT_PROROOT_ROOTFS_URL,
  DEFAULT_PROROOT_ROOTFS_SHA256,
  DEFAULT_PROROOT_ROOTFS_FORMAT,
  DEFAULT_PROROOT_ROOTFS_STRIP,
} from "./runtime-manager.js";
