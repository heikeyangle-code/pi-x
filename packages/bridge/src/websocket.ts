import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { lstat, readFile, readlink, realpath, stat, unlink } from "node:fs/promises";
import { resolve, extname, basename, relative, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import {
  parseClientMessage,
  type AssistantContent,
  type ClientMessage,
  type DebugTraceEvent,
  type ImageChange,
  type Provider,
  type ServerMessage,
} from "./parser.js";
import {
  BRIDGE_PROTOCOL_MAX_VERSION,
  BRIDGE_PROTOCOL_MIN_VERSION,
  clientProtocolRange,
  negotiateProtocolVersion,
} from "./protocol-version.js";
import type { ImageRef, ImageStore } from "./image-store.js";
import type { MediaStore } from "./media-store.js";
import {
  isSafeUploadFileName,
  UploadStoreError,
  type UploadStore,
} from "./upload-store.js";
import type { GalleryStore } from "./gallery-store.js";
import type { ProjectHistory } from "./project-history.js";
import {
  type ResolvedWorkspace,
  type WorkspaceStore,
} from "./workspace-store.js";
import { WorktreeStore } from "./worktree-store.js";
import {
  listWorktrees,
  removeWorktree,
  createWorktree,
  worktreeExists,
  getMainBranch,
} from "./worktree.js";
import {
  stageFiles,
  stageHunks,
  unstageFiles,
  unstageHunks,
  gitCommit,
  gitPush,
  listProjectFilesAndDirectoriesForClient,
  listBranches,
  createBranch,
  checkoutBranch,
  revertFiles,
  revertHunks,
  gitFetch,
  gitPull,
  gitRemoteStatus,
  gitStatus,
} from "./git-operations.js";
import { generateCommitMessage } from "./git-assist.js";
import { listWindows } from "./screenshot.js";
import { DebugTraceStore } from "./debug-trace-store.js";
import { RecordingStore } from "./recording-store.js";
import { fetchAllUsage } from "./usage.js";
import type { PromptHistoryBackupStore } from "./prompt-history-backup.js";
import type { PromptHistoryStore } from "./prompt-history-store.js";
import { getPackageVersion } from "./version.js";
import {
  isPathWithinAllowedDirectory,
  resolvePlatformPath,
  resolvePlatformPathFrom,
} from "./path-utils.js";
import {
  DirectoryListingError,
  listAllowedDirectories,
} from "./directory-listing.js";
import {
  PiAdapter,
  isFailedEngineResponse,
  toServerMessage,
} from "./pi-host/pi-adapter.js";
import {
  scanPiRecentSessions,
  piMessagesToHistoryMessages,
  piSessionFileToHistoryMessages,
  piSessionImagesFromJsonl,
  type PiHistoryMessage,
  type PiSessionEntry,
  type PiSessionImage,
  type PiSessionMeta,
} from "./pi-host/pi-sessions.js";

type CorrelatedProjectRequest = {
  projectPath: string;
  requestId?: string;
};

function projectRequestMetadata(
  request: CorrelatedProjectRequest,
): { projectPath: string; requestId?: string } {
  return {
    projectPath: request.projectPath,
    ...(request.requestId ? { requestId: request.requestId } : {}),
  };
}


const OPT_IN_SERVER_MESSAGES = new Set<string>([
  "conversation_queue",
  "goal_state",
  "guardian_approval",
  "prompt_history_status",
  "projects",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


const MAX_TIMER_DELAY_MS = 2_147_483_647;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMER_DELAY_MS
    ? value
    : fallback;
}

function normalizePositiveLimit(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeNonNegativeLimit(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMER_DELAY_MS
    ? value
    : fallback;
}

const FILE_PEEK_MEDIA_TYPES: Record<
  string,
  { kind: "audio" | "video"; mimeType: string }
> = {
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".aac": { kind: "audio", mimeType: "audio/aac" },
  ".flac": { kind: "audio", mimeType: "audio/flac" },
  ".ogg": { kind: "audio", mimeType: "audio/ogg" },
  ".opus": { kind: "audio", mimeType: "audio/ogg" },
  ".aif": { kind: "audio", mimeType: "audio/aiff" },
  ".aiff": { kind: "audio", mimeType: "audio/aiff" },
  ".aifc": { kind: "audio", mimeType: "audio/aiff" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".m4v": { kind: "video", mimeType: "video/x-m4v" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".mkv": { kind: "video", mimeType: "video/x-matroska" },
  ".avi": { kind: "video", mimeType: "video/x-msvideo" },
  ".mpg": { kind: "video", mimeType: "video/mpeg" },
  ".mpeg": { kind: "video", mimeType: "video/mpeg" },
};

export function downloadMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const mediaType = FILE_PEEK_MEDIA_TYPES[extension];
  if (mediaType) return mediaType.mimeType;
  const mimeTypes: Record<string, string> = {
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".gz": "application/gzip",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "image/svg+xml",
    ".tar": "application/x-tar",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xml": "application/xml",
    ".zip": "application/zip",
  };
  return mimeTypes[extension] ?? "application/octet-stream";
}


export interface BridgeServerOptions {
  server: HttpServer;
  apiKey?: string;
  allowedDirs?: string[];
  imageStore?: ImageStore;
  mediaStore?: MediaStore;
  uploadStore?: UploadStore;
  galleryStore?: GalleryStore;
  projectHistory?: ProjectHistory;
  workspaceStore?: WorkspaceStore;
  debugTraceStore?: DebugTraceStore;
  recordingStore?: RecordingStore;
  promptHistoryBackup?: PromptHistoryBackupStore;
  promptHistoryStore?: PromptHistoryStore;
  /**
   * Optional pi engine adapter (PI_HOST=1). When present, CC chat-turn messages
   * (start/input/approve/reject/answer/stop_session) route to the pi engine;
   * files/workspace/git/upload/download stay on this server unchanged.
   */
  piAdapter?: PiAdapter | null;
  platform?: NodeJS.Platform;
  fileListMaxEntries?: number;
  fileListMaxBytes?: number;
  fileDownloadMaxBytes?: number;
  fileUploadMaxBytes?: number;
  deltaBatchMs?: number;
  deltaBatchMaxChars?: number;
}

type DeltaServerMessage = Extract<
  ServerMessage,
  { type: "stream_delta" | "thinking_delta" }
>;

interface DeltaBatch {
  messages: DeltaServerMessage[];
  timer: NodeJS.Timeout;
  charCount: number;
}

interface DeltaTextChunk {
  text: string;
  charCount: number;
}

export class BridgeWebSocketServer {
  private static readonly MAX_DEBUG_EVENTS = 800;
  private static readonly MAX_HISTORY_SUMMARY_ITEMS = 300;
  private static readonly DEFAULT_FILE_LIST_MAX_ENTRIES = 5000;
  private static readonly DEFAULT_FILE_LIST_MAX_BYTES = 512 * 1024;
  private static readonly DEFAULT_FILE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
  private static readonly DEFAULT_FILE_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
  private static readonly DEFAULT_DELTA_BATCH_MS = 100;
  private static readonly DEFAULT_DELTA_BATCH_MAX_CHARS = 4096;

  private wss: WebSocketServer;
  /** Optional pi engine adapter; null in non-PI mode (behaviour unchanged). */
  private piAdapter: PiAdapter | null = null;
  private apiKey: string | null;
  private allowedDirs: string[];
  private imageStore: ImageStore | null;
  private mediaStore: MediaStore | null;
  private uploadStore: UploadStore | null;
  private galleryStore: GalleryStore | null;
  private projectHistory: ProjectHistory | null;
  private workspaceStore: WorkspaceStore | null;
  private debugTraceStore: DebugTraceStore;
  private recordingStore: RecordingStore | null;
  private worktreeStore: WorktreeStore;
  private promptHistoryBackup: PromptHistoryBackupStore | null;
  private promptHistoryStore: PromptHistoryStore | null;

  private debugEvents = new Map<string, DebugTraceEvent[]>();
  private readonly fileListMaxEntries: number;
  private readonly fileListMaxBytes: number;
  private readonly fileDownloadMaxBytes: number;
  private readonly fileUploadMaxBytes: number;
  private readonly deltaBatchMs: number;
  private readonly deltaBatchMaxChars: number;
  private deltaBatches = new Map<WebSocket, Map<string, DeltaBatch>>();
  private platform: NodeJS.Platform;
  private clientSupportedServerMessages = new WeakMap<WebSocket, Set<string>>();
  private clientProtocolVersions = new WeakMap<WebSocket, number>();
  private rejectedProtocolClients = new WeakSet<WebSocket>();

  constructor(options: BridgeServerOptions) {
    const {
      server,
      apiKey,
      allowedDirs,
      imageStore,
      mediaStore,
      uploadStore,
      galleryStore,
      projectHistory,
      workspaceStore,
      debugTraceStore,
      recordingStore,
      promptHistoryBackup,
      promptHistoryStore,
      platform,
      fileListMaxEntries,
      fileListMaxBytes,
      fileDownloadMaxBytes,
      fileUploadMaxBytes,
      deltaBatchMs,
      deltaBatchMaxChars,
    } = options;
    this.apiKey = apiKey ?? null;
    this.allowedDirs = allowedDirs ?? [];
    this.imageStore = imageStore ?? null;
    this.mediaStore = mediaStore ?? null;
    this.uploadStore = uploadStore ?? null;
    this.galleryStore = galleryStore ?? null;
    this.projectHistory = projectHistory ?? null;
    this.workspaceStore = workspaceStore ?? null;
    this.debugTraceStore = debugTraceStore ?? new DebugTraceStore();
    this.recordingStore = recordingStore ?? null;
    this.worktreeStore = new WorktreeStore();
    this.promptHistoryBackup = promptHistoryBackup ?? null;
    this.promptHistoryStore = promptHistoryStore ?? null;
    this.platform = platform ?? process.platform;
    this.piAdapter = options.piAdapter ?? null;
    if (this.piAdapter) {
      // Route pi engine events to the owning client through this server's own
      // send() so protocol/opt-in filtering still applies.
      this.piAdapter.deliver = (ws, message) =>
        this.send(ws, toServerMessage(message));
      // Keep the session list in sync when a pi session changes status
      // (idle->running etc.) so the app's active-session UI stays current.
      this.piAdapter.onStatus = () => this.broadcastPiSessionList();
    }
    this.fileListMaxEntries = normalizePositiveLimit(
      fileListMaxEntries,
      positiveEnvInt(
        "BRIDGE_FILE_LIST_MAX_ENTRIES",
        BridgeWebSocketServer.DEFAULT_FILE_LIST_MAX_ENTRIES,
      ),
    );
    this.fileListMaxBytes = normalizePositiveLimit(
      fileListMaxBytes,
      positiveEnvInt(
        "BRIDGE_FILE_LIST_MAX_BYTES",
        BridgeWebSocketServer.DEFAULT_FILE_LIST_MAX_BYTES,
      ),
    );
    this.fileDownloadMaxBytes = normalizePositiveLimit(
      fileDownloadMaxBytes,
      positiveEnvInt(
        "BRIDGE_FILE_DOWNLOAD_MAX_SIZE_MB",
        BridgeWebSocketServer.DEFAULT_FILE_DOWNLOAD_MAX_BYTES / 1024 / 1024,
      ) * 1024 * 1024,
    );
    this.fileUploadMaxBytes = normalizePositiveLimit(
      fileUploadMaxBytes,
      positiveEnvInt(
        "BRIDGE_FILE_UPLOAD_MAX_SIZE_MB",
        BridgeWebSocketServer.DEFAULT_FILE_UPLOAD_MAX_BYTES / 1024 / 1024,
      ) * 1024 * 1024,
    );
    this.deltaBatchMs = normalizeNonNegativeLimit(
      deltaBatchMs,
      nonNegativeEnvInt(
        "BRIDGE_DELTA_BATCH_MS",
        BridgeWebSocketServer.DEFAULT_DELTA_BATCH_MS,
      ),
    );
    this.deltaBatchMaxChars = normalizePositiveLimit(
      deltaBatchMaxChars,
      positiveEnvInt(
        "BRIDGE_DELTA_BATCH_MAX_CHARS",
        BridgeWebSocketServer.DEFAULT_DELTA_BATCH_MAX_CHARS,
      ),
    );

    void this.debugTraceStore.init().catch((err) => {
      console.error("[ws] Failed to initialize debug trace store:", err);
    });
    if (this.recordingStore) {
      void this.recordingStore.init().catch((err) => {
        console.error("[ws] Failed to initialize recording store:", err);
      });
    }

    this.wss = new WebSocketServer({ server });


    this.wss.on("connection", (ws, req) => {
      // API key authentication
      if (this.apiKey) {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const token = url.searchParams.get("token");
        if (token !== this.apiKey) {
          console.log("[ws] Client rejected: invalid token");
          ws.close(4001, "Unauthorized");
          return;
        }
      }

      console.log("[ws] Client connected");
      this.handleConnection(ws);
    });

    this.wss.on("error", (err) => {
      console.error("[ws] Server error:", err.message);
    });

    console.log(`[ws] WebSocket server attached to HTTP server`);
  }

  /**
   * Validate that a project path is within the allowed directories.
   * Returns true if the path is allowed, false otherwise.
   */
  private isPathAllowed(path: string): boolean {
    if (this.allowedDirs.length === 0) return true;
    return this.allowedDirs.some(
      (dir) => isPathWithinAllowedDirectory(path, dir, this.platform),
    );
  }

  private async isCanonicalPathAllowed(path: string): Promise<boolean> {
    if (this.allowedDirs.length === 0) return true;
    for (const dir of this.allowedDirs) {
      let canonicalDir = dir;
      try {
        canonicalDir = await realpath(dir);
      } catch {
        // Keep the configured path when the allowed root cannot be resolved.
      }
      if (isPathWithinAllowedDirectory(path, canonicalDir, this.platform)) {
        return true;
      }
    }
    return false;
  }

  private sendFileDownloadError(
    ws: WebSocket,
    request: Extract<ClientMessage, { type: "prepare_file_download" }>,
    errorCode:
      | "file_download_not_allowed"
      | "file_download_not_found"
      | "file_download_not_file"
      | "file_download_too_large"
      | "file_download_unavailable"
      | "file_download_failed",
    message: string,
  ): void {
    this.send(ws, {
      type: "error",
      errorCode,
      message,
      path: request.filePath,
      requestId: request.requestId,
    });
  }

  private async prepareFileDownload(
    ws: WebSocket,
    request: Extract<ClientMessage, { type: "prepare_file_download" }>,
  ): Promise<void> {
    const pathApi = this.platform === "win32" ? win32 : posix;
    const projectPath = pathApi.resolve(request.projectPath);
    if (pathApi.isAbsolute(request.filePath)) {
      this.sendFileDownloadError(
        ws,
        request,
        "file_download_not_allowed",
        "Only project-relative file paths can be downloaded.",
      );
      return;
    }

    const requestedPath = pathApi.resolve(projectPath, request.filePath);
    if (
      !this.isPathAllowed(projectPath) ||
      !isPathWithinAllowedDirectory(
        requestedPath,
        projectPath,
        this.platform,
      )
    ) {
      this.sendFileDownloadError(
        ws,
        request,
        "file_download_not_allowed",
        "The requested file is outside the current project.",
      );
      return;
    }

    let canonicalProjectPath: string;
    try {
      canonicalProjectPath = await realpath(projectPath);
      const projectStat = await stat(canonicalProjectPath);
      if (!projectStat.isDirectory()) throw new Error("not a directory");
    } catch {
      this.sendFileDownloadError(
        ws,
        request,
        "file_download_not_allowed",
        "The current project is unavailable or not allowed.",
      );
      return;
    }

    let canonicalFilePath: string;
    try {
      canonicalFilePath = await realpath(requestedPath);
    } catch {
      this.sendFileDownloadError(
        ws,
        request,
        "file_download_not_found",
        "File not found.",
      );
      return;
    }

    if (
      !isPathWithinAllowedDirectory(
        canonicalFilePath,
        canonicalProjectPath,
        this.platform,
      ) ||
      !(await this.isCanonicalPathAllowed(canonicalFilePath))
    ) {
      this.sendFileDownloadError(
        ws,
        request,
        "file_download_not_allowed",
        "The requested file resolves outside the current project.",
      );
      return;
    }

    try {
      const fileStat = await stat(canonicalFilePath);
      if (!fileStat.isFile()) {
        this.sendFileDownloadError(
          ws,
          request,
          "file_download_not_file",
          "Only regular files can be downloaded.",
        );
        return;
      }
      if (fileStat.size > this.fileDownloadMaxBytes) {
        const maxSizeMb = Math.max(
          1,
          Math.ceil(this.fileDownloadMaxBytes / 1024 / 1024),
        );
        this.sendFileDownloadError(
          ws,
          request,
          "file_download_too_large",
          `File is too large to download. Maximum size is ${maxSizeMb} MB.`,
        );
        return;
      }
      if (!this.mediaStore) {
        this.sendFileDownloadError(
          ws,
          request,
          "file_download_unavailable",
          "File downloads are unavailable on this Bridge.",
        );
        return;
      }

      const fileName = pathApi.basename(requestedPath);
      const mimeType = downloadMimeType(fileName);
      const ref = await this.mediaStore.register(
        canonicalFilePath,
        mimeType,
        fileStat.size,
        fileName,
      );
      this.send(ws, {
        type: "file_download_ready",
        requestId: request.requestId,
        filePath: request.filePath,
        fileName,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        downloadUrl: ref.url,
      });
    } catch {
      this.sendFileDownloadError(
        ws,
        request,
        "file_download_failed",
        "Unable to prepare the file download.",
      );
    }
  }

  private sendFileUploadError(
    ws: WebSocket,
    requestId: string,
    errorCode: string,
    message: string,
    path?: string,
  ): void {
    this.send(ws, { type: "error", errorCode, message, requestId, path });
  }

  private async prepareFileUpload(
    ws: WebSocket,
    request: Extract<ClientMessage, { type: "prepare_file_upload" }>,
  ): Promise<void> {
    const pathApi = this.platform === "win32" ? win32 : posix;
    const projectPath = pathApi.resolve(request.projectPath);
    if (
      !this.uploadStore ||
      pathApi.isAbsolute(request.directoryPath) ||
      !isSafeUploadFileName(request.fileName)
    ) {
      this.sendFileUploadError(
        ws,
        request.requestId,
        !this.uploadStore ? "file_upload_unavailable" : "file_upload_not_allowed",
        !this.uploadStore
          ? "File uploads are unavailable on this Bridge."
          : "The upload destination or file name is not allowed.",
        request.directoryPath,
      );
      return;
    }
    if (request.sizeBytes > this.fileUploadMaxBytes) {
      this.sendFileUploadError(
        ws,
        request.requestId,
        "file_upload_too_large",
        `File is too large to upload. Maximum size is ${Math.ceil(this.fileUploadMaxBytes / 1024 / 1024)} MB.`,
        request.fileName,
      );
      return;
    }

    const requestedDirectory = pathApi.resolve(projectPath, request.directoryPath || ".");
    if (
      !this.isPathAllowed(projectPath) ||
      !isPathWithinAllowedDirectory(requestedDirectory, projectPath, this.platform)
    ) {
      this.sendFileUploadError(ws, request.requestId, "file_upload_not_allowed", "The upload destination is outside the current project.", request.directoryPath);
      return;
    }

    try {
      const canonicalProject = await realpath(projectPath);
      const canonicalDirectory = await realpath(requestedDirectory);
      const directoryStat = await stat(canonicalDirectory);
      if (
        !directoryStat.isDirectory() ||
        !isPathWithinAllowedDirectory(canonicalDirectory, canonicalProject, this.platform) ||
        !(await this.isCanonicalPathAllowed(canonicalDirectory))
      ) {
        throw new UploadStoreError("file_upload_directory_changed", "The upload destination is not allowed.");
      }
      const ref = await this.uploadStore.register({
        directoryPath: canonicalDirectory,
        relativeDirectoryPath: pathApi
          .relative(projectPath, requestedDirectory)
          .split(pathApi.sep)
          .join("/"),
        fileName: request.fileName,
        sizeBytes: request.sizeBytes,
        conflictPolicy: request.conflictPolicy,
      });
      this.send(ws, {
        type: "file_upload_ready",
        requestId: request.requestId,
        fileName: request.fileName,
        sizeBytes: request.sizeBytes,
        uploadUrl: ref.url,
        uploadToken: ref.token,
      });
    } catch (error) {
      const known = error instanceof UploadStoreError ? error : null;
      this.sendFileUploadError(
        ws,
        request.requestId,
        known?.code ?? "file_upload_directory_not_found",
        known?.message ?? "The upload destination was not found or is not allowed.",
        request.directoryPath,
      );
    }
  }

  private async finalizeFileUpload(
    ws: WebSocket,
    request: Extract<ClientMessage, { type: "finalize_file_upload" }>,
  ): Promise<void> {
    if (!this.uploadStore) {
      this.sendFileUploadError(ws, request.requestId, "file_upload_unavailable", "File uploads are unavailable on this Bridge.");
      return;
    }
    try {
      const result = await this.uploadStore.finalize(request.uploadToken, request.sha256);
      this.send(ws, { type: "file_upload_complete", requestId: request.requestId, ...result });
    } catch (error) {
      const known = error instanceof UploadStoreError ? error : null;
      this.sendFileUploadError(ws, request.requestId, known?.code ?? "file_upload_failed", known?.message ?? "Unable to finish the file upload.");
    }
  }

  /** Build a user-friendly error for disallowed project paths. */
  private buildPathNotAllowedError(
    projectPath: string,
    requestId?: string,
  ): Extract<ServerMessage, { type: "error" }> {
    return {
      type: "error",
      message: `⚠ Project path not allowed\n\n"${projectPath}" is not in the allowed directories.\n\nFix: Update BRIDGE_ALLOWED_DIRS on the Bridge server to include this path.`,
      errorCode: "path_not_allowed",
      path: projectPath,
      requestId,
    };
  }



  close(): void {
    console.log("[ws] Shutting down...");
    this.flushAllDeltaBatches();
    void this.piAdapter?.stopAll();
    this.debugEvents.clear();
    this.wss.close();
  }

  /** Return session count for /health endpoint. */
  get sessionCount(): number {
    return this.piAdapter?.registry.list().length ?? 0;
  }

  /** Return connected WebSocket client count. */
  get clientCount(): number {
    return this.wss.clients.size;
  }

  private handleConnection(ws: WebSocket): void {
    // Send session list and project history on connect
    this.sendPiSessionList(ws);
    const projects = this.legacyProjectHistoryProjects();
    this.send(ws, { type: "project_history", projects });

    ws.on("message", (data) => {
      if (this.rejectedProtocolClients.has(ws)) return;
      const raw = data.toString();
      const msg = parseClientMessage(raw);

      if (!msg) {
        // Try to extract the message type so the client can decide how to
        // handle the unsupported message (suppress vs show update hint).
        let rawType: string | undefined;
        try {
          rawType = (JSON.parse(raw) as Record<string, unknown>)
            ?.type as string;
        } catch {
          /* ignore */
        }
        if (rawType === "client_capabilities") {
          this.rejectedProtocolClients.add(ws);
          this.send(ws, {
            type: "error",
            errorCode: "incompatible_protocol",
            message: "Client advertised a malformed protocol range.",
            protocolVersion: BRIDGE_PROTOCOL_MAX_VERSION,
            minimumProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
          });
          ws.close(4406, "Incompatible protocol version");
          return;
        }
        console.error(
          "[ws] Unsupported message:",
          rawType ?? raw.slice(0, 200),
        );
        this.send(ws, {
          type: "error",
          errorCode: "unsupported_message",
          message: rawType ?? "unknown",
        });
        return;
      }

      console.log(`[ws] Received: ${msg.type}`);
      this.handleClientMessage(msg, ws);
    });

    ws.on("close", () => {
      console.log("[ws] Client disconnected");
      this.discardClientDeltaBatches(ws);
    });

    ws.on("error", (err) => {
      console.error("[ws] Client error:", err.message);
    });
  }


  private async handleClientMessage(
    msg: ClientMessage,
    ws: WebSocket,
  ): Promise<void> {
    if (this.rejectedProtocolClients.has(ws)) return;
    if (msg.type === "client_capabilities") {
      const clientRange = clientProtocolRange(msg);
      const selectedProtocolVersion = negotiateProtocolVersion(clientRange);
      if (selectedProtocolVersion === null) {
        this.rejectedProtocolClients.add(ws);
        this.send(ws, {
          type: "error",
          errorCode: "incompatible_protocol",
          protocolVersion: BRIDGE_PROTOCOL_MAX_VERSION,
          minimumProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
          message:
            `Client protocol range ${clientRange.min}-${clientRange.max} `
            + `does not overlap Bridge protocol range `
            + `${BRIDGE_PROTOCOL_MIN_VERSION}-${BRIDGE_PROTOCOL_MAX_VERSION}.`,
        });
        ws.close(4406, "Incompatible protocol version");
        return;
      }
      this.clientProtocolVersions.set(ws, selectedProtocolVersion);
      this.clientSupportedServerMessages.set(
        ws,
        new Set(msg.supportedServerMessages ?? []),
      );
      this.sendPromptHistoryStatus(ws);
      return;
    }

    // PI_HOST=1: route CC chat-turn messages to the pi engine. Everything else
    // (files, workspace, git, upload, download) proceeds on the existing path.
    if (this.piAdapter && this.piAdapter.accepts(msg)) {
      if (await this.piAdapter.handle(ws, msg)) return;
    }

    // Session surface (list/history/context/recent/rename) is served from the
    // pi engine + ~/.pi/agent/sessions. Returns true when the pi adapter
    // consumed the op.
    if (this.piAdapter) {
      if (await this.tryHandlePiSessionOp(ws, msg)) return;
    }

    const incomingSessionId = this.extractSessionIdFromClientMessage(msg);
    const isActiveRuntimeSession =
      incomingSessionId != null &&
      this.piAdapter?.registry.get(incomingSessionId) != null;
    if (incomingSessionId && isActiveRuntimeSession) {
      this.recordDebugEvent(incomingSessionId, {
        direction: "incoming",
        channel: "ws",
        type: msg.type,
        detail: this.summarizeClientMessage(msg),
      });
      this.recordingStore?.record(incomingSessionId, "incoming", msg);
    }

    switch (msg.type) {
      case "set_permission_mode": {
        this.send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: "Permission mode changes are not supported by the pi engine",
          errorCode: "set_permission_mode_rejected",
        });
        break;
      }

      case "set_sandbox_mode": {
        this.send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: "Sandbox mode changes are not supported by the pi engine",
          errorCode: "set_sandbox_mode_rejected",
        });
        break;
      }

      case "refresh_branch": {
        const entry = this.piAdapter?.registry.get(msg.sessionId);
        if (entry) {
          const cwd = entry.projectId;
          let branch = "";
          try {
            branch = execFileSync(
              "git",
              ["rev-parse", "--abbrev-ref", "HEAD"],
              {
                cwd,
                encoding: "utf-8",
              },
            ).trim();
          } catch {
            /* not a git repo */
          }
          this.send(ws, {
            type: "branch_update",
            sessionId: msg.sessionId,
            branch,
          });
        } else {
          this.send(ws, {
            type: "error",
            sessionId: msg.sessionId,
            message: `Session ${msg.sessionId} not found`,
          });
        }
        break;
      }

      case "get_debug_bundle": {
        const entry = msg.sessionId
          ? this.piAdapter?.registry.get(msg.sessionId)
          : undefined;
        if (!entry) {
          this.send(ws, {
            type: "error",
            sessionId: msg.sessionId,
            message: `Session ${msg.sessionId} not found`,
          });
          return;
        }

        const emitBundle = (diff: string, diffError?: string): void => {
          const traceLimit =
            msg.traceLimit ?? BridgeWebSocketServer.MAX_DEBUG_EVENTS;
          const trace = this.getDebugEvents(msg.sessionId, traceLimit);
          const generatedAt = new Date().toISOString();
          const bundlePayload: Record<string, unknown> = {
            type: "debug_bundle",
            sessionId: msg.sessionId,
            generatedAt,
            session: {
              id: entry.sessionId,
              status: entry.status,
              projectPath: entry.projectId,
              createdAt: new Date(entry.createdAt).toISOString(),
              lastActivityAt: new Date(entry.updatedAt).toISOString(),
            },
            debugTrace: trace,
            traceFilePath: this.debugTraceStore.getTraceFilePath(msg.sessionId),
            diff,
            diffError,
          };
          const savedBundlePath = this.debugTraceStore.getBundleFilePath(
            msg.sessionId,
            generatedAt,
          );
          bundlePayload.savedBundlePath = savedBundlePath;
          this.debugTraceStore.saveBundleAtPath(savedBundlePath, bundlePayload);
          this.send(ws, bundlePayload);
        };

        if (msg.includeDiff === false) {
          emitBundle("");
          break;
        }

        const cwd = entry.projectId;
        this.collectGitDiff(cwd, ({ diff, error }) => {
          emitBundle(diff, error);
        });
        break;
      }

      case "get_usage": {
        fetchAllUsage()
          .then((providers) => {
            this.send(ws, { type: "usage_result", providers } as Record<
              string,
              unknown
            >);
          })
          .catch((err) => {
            this.send(ws, {
              type: "error",
              message: `Failed to fetch usage: ${err}`,
            });
          });
        break;
      }

      case "list_gallery": {
        const projectPath = msg.projectPath ?? msg.project;
        if (this.galleryStore) {
          const images = this.galleryStore.list({
            projectPath,
            sessionId: msg.sessionId,
          });
          this.send(ws, {
            type: "gallery_list",
            images,
            projectPath,
            sessionId: msg.sessionId,
            requestId: msg.requestId,
          });
        } else {
          this.send(ws, {
            type: "gallery_list",
            images: [],
            projectPath,
            sessionId: msg.sessionId,
            requestId: msg.requestId,
          });
        }
        break;
      }

      case "get_message_images": {
        void this
          .loadPiSessionImages(msg.claudeSessionId, msg.messageUuid)
          .then((images) => {
            const refs: Array<{ id: string; url: string; mimeType: string }> =
              [];
            if (this.imageStore) {
              for (const img of images) {
                const ref = this.imageStore.registerFromBase64(
                  img.base64,
                  img.mimeType,
                );
                if (ref) refs.push(ref);
              }
            }
            this.send(ws, {
              type: "message_images_result",
              messageUuid: msg.messageUuid,
              images: refs,
            });
          })
          .catch((err) => {
            console.error("[ws] Failed to extract message images:", err);
            this.send(ws, {
              type: "message_images_result",
              messageUuid: msg.messageUuid,
              images: [],
            });
          });
        break;
      }

      case "interrupt": {
        const adapter = this.piAdapter;
        const piEntry = msg.sessionId
          ? adapter?.registry.get(msg.sessionId)
          : undefined;
        if (adapter && piEntry) {
          await adapter.gateway.handleControl({
            type: "control",
            op: "abort",
            projectId: piEntry.projectId,
          });
          break;
        }
        this.send(ws, {
          type: "error",
          sessionId: msg.sessionId,
          message: "No active session.",
        });
        break;
      }

      case "list_project_history": {
        const projects = this.legacyProjectHistoryProjects();
        this.send(ws, { type: "project_history", projects });
        break;
      }

      case "remove_project_history": {
        this.projectHistory?.removeProject(msg.projectPath);
        const projects = this.legacyProjectHistoryProjects();
        this.send(ws, { type: "project_history", projects });
        break;
      }

      case "list_projects": {
        this.send(ws, this.projectsMessage(msg.requestId));
        break;
      }

      case "create_project": {
        if (!this.workspaceStore) {
          this.send(ws, {
            type: "error",
            requestId: msg.requestId,
            errorCode: "projects_unavailable",
            message: "Project storage is unavailable",
          });
          break;
        }
        const normalized = this.normalizeWorkspaceRoots(msg.rootPaths);
        if (normalized.deniedRoot || !normalized.roots) {
          this.send(
            ws,
            this.buildPathNotAllowedError(
              normalized.deniedRoot ?? msg.rootPaths[0],
            ),
          );
          break;
        }
        try {
          await this.workspaceStore.createProject(msg.name, normalized.roots);
          this.broadcast(this.projectsMessage(msg.requestId));
        } catch (error) {
          this.sendWorkspaceMutationError(ws, msg.requestId, "create Project", error);
        }
        break;
      }

      case "update_project": {
        if (!this.workspaceStore) {
          this.send(ws, {
            type: "error",
            requestId: msg.requestId,
            errorCode: "projects_unavailable",
            message: "Project storage is unavailable",
          });
          break;
        }
        const normalized = this.normalizeWorkspaceRoots(msg.rootPaths);
        if (normalized.deniedRoot || !normalized.roots) {
          this.send(
            ws,
            this.buildPathNotAllowedError(
              normalized.deniedRoot ?? msg.rootPaths[0],
            ),
          );
          break;
        }
        let updated;
        try {
          updated = await this.workspaceStore.updateProject(
            msg.projectId,
            msg.name,
            normalized.roots,
          );
        } catch (error) {
          this.sendWorkspaceMutationError(ws, msg.requestId, "update Project", error);
          break;
        }
        if (!updated) {
          this.send(ws, {
            type: "error",
            requestId: msg.requestId,
            errorCode: "project_not_found",
            message: `Project not found: ${msg.projectId}`,
          });
          break;
        }
        this.broadcast(this.projectsMessage(msg.requestId));
        break;
      }

      case "remove_project": {
        if (!this.workspaceStore) {
          this.sendWorkspaceMutationError(
            ws,
            msg.requestId,
            "remove Project",
            new Error("Project storage is unavailable"),
          );
          break;
        }
        let removed;
        try {
          removed = await this.workspaceStore.removeProject(msg.projectId);
        } catch (error) {
          this.sendWorkspaceMutationError(ws, msg.requestId, "remove Project", error);
          break;
        }
        if (!removed) {
          this.send(ws, {
            type: "error",
            requestId: msg.requestId,
            errorCode: "project_not_found",
            message: `Project not found: ${msg.projectId}`,
          });
          break;
        }
        this.broadcast(this.projectsMessage(msg.requestId));
        break;
      }

      case "list_directory": {
        try {
          const listing = await listAllowedDirectories(
            msg.path,
            this.allowedDirs,
            this.platform,
            msg.includeHidden ?? false,
          );
          this.send(ws, {
            type: "directory_listing",
            path: listing.path,
            directories: listing.directories,
            requestId: msg.requestId,
          });
        } catch (error) {
          const listingError =
            error instanceof DirectoryListingError
              ? error
              : new DirectoryListingError(
                  "directory_read_failed",
                  "Unable to read directory",
                );
          this.send(ws, {
            type: "error",
            errorCode: listingError.code,
            message: listingError.message,
            path: msg.path,
            requestId: msg.requestId,
          });
        }
        break;
      }

      case "prepare_file_download": {
        void this.prepareFileDownload(ws, msg);
        break;
      }

      case "prepare_file_upload": {
        void this.prepareFileUpload(ws, msg);
        break;
      }

      case "finalize_file_upload": {
        void this.finalizeFileUpload(ws, msg);
        break;
      }

      case "cancel_file_upload": {
        if (this.uploadStore) void this.uploadStore.cancel(msg.uploadToken);
        break;
      }

      case "read_file":

      case "read_media_file": {
        const responseMetadata = {
          ...projectRequestMetadata(msg),
          filePath: msg.filePath,
        };
        const absPath = resolve(msg.projectPath, msg.filePath);
        if (!this.isPathAllowed(absPath)) {
          this.send(ws, {
            type: "file_content",
            ...responseMetadata,
            content: "",
            error: "Path not allowed",
          });
          break;
        }
        void (async () => {
          try {
            if (!existsSync(absPath)) {
              this.send(ws, {
                type: "file_content",
                ...responseMetadata,
                content: "",
                error: "File not found",
              });
              return;
            }
            const fileStat = await lstat(absPath);
            if (fileStat.isSymbolicLink()) {
              let targetPath = "";
              try {
                targetPath = await readlink(absPath);
              } catch {
                // Best effort only; the user-facing error still works without it.
              }
              let resolvedTargetStat;
              try {
                resolvedTargetStat = await stat(absPath);
              } catch {
                this.send(ws, {
                  type: "file_content",
                  ...responseMetadata,
                  content: "",
                  error:
                    targetPath.length > 0
                      ? `This symbolic link points to a missing target: ${targetPath}`
                      : "This symbolic link points to a missing target.",
                });
                return;
              }
              if (resolvedTargetStat.isDirectory()) {
                this.send(ws, {
                  type: "file_content",
                  ...responseMetadata,
                  content: "",
                  error:
                    targetPath.length > 0
                      ? `This symbolic link points to a directory (${targetPath}). Open the target directory instead.`
                      : "This symbolic link points to a directory. Open the target directory instead.",
                });
                return;
              }
            } else if (fileStat.isDirectory()) {
              this.send(ws, {
                type: "file_content",
                ...responseMetadata,
                content: "",
                error: "This path is a directory. Open a file instead.",
              });
              return;
            }
            const resolvedFileStat = fileStat.isSymbolicLink()
              ? await stat(absPath)
              : fileStat;
            const canonicalPath = await realpath(absPath);
            if (!(await this.isCanonicalPathAllowed(canonicalPath))) {
              this.send(ws, {
                type: "file_content",
                ...responseMetadata,
                content: "",
                error: "Path not allowed",
              });
              return;
            }
            const ext = extname(absPath).toLowerCase();
            const mediaType = FILE_PEEK_MEDIA_TYPES[ext];
            if (mediaType) {
              if (!this.mediaStore) {
                this.send(ws, {
                  type: "file_content",
                  ...responseMetadata,
                  kind: mediaType.kind,
                  content: "",
                  mimeType: mediaType.mimeType,
                  sizeBytes: resolvedFileStat.size,
                  error: "Media preview is unavailable on this Bridge.",
                });
                return;
              }
              const ref = await this.mediaStore.register(
                canonicalPath,
                mediaType.mimeType,
                resolvedFileStat.size,
              );
              this.send(ws, {
                type: "file_content",
                ...responseMetadata,
                kind: mediaType.kind,
                content: "",
                mimeType: ref.mimeType,
                sizeBytes: ref.sizeBytes,
                mediaUrl: ref.url,
              });
              return;
            }
            if (msg.type === "read_media_file") {
              this.send(ws, {
                type: "file_content",
                ...responseMetadata,
                content: "",
                error: "Unsupported media file type.",
              });
              return;
            }
            if (BridgeWebSocketServer.FILE_PEEK_IMAGE_EXTENSIONS.has(ext)) {
              const mimeType = BridgeWebSocketServer.mimeTypeForExt(ext);
              if (resolvedFileStat.size > BridgeWebSocketServer.MAX_IMAGE_SIZE) {
                this.send(ws, {
                  type: "file_content",
                  ...responseMetadata,
                  kind: "image",
                  content: "",
                  mimeType,
                  sizeBytes: resolvedFileStat.size,
                  error: "Image too large to preview. Maximum size is 5 MB.",
                });
                return;
              }
              const buf = await readFile(absPath);
              this.send(ws, {
                type: "file_content",
                ...responseMetadata,
                kind: "image",
                content: "",
                base64: buf.toString("base64"),
                mimeType,
                sizeBytes: buf.length,
              });
              return;
            }
            const maxLines =
              typeof msg.maxLines === "number" && msg.maxLines > 0
                ? msg.maxLines
                : 5000;
            const raw = await readFile(absPath, "utf-8");
            const textExt = ext.replace(/^\./, "").toLowerCase();
            const languageMap: Record<string, string> = {
              ts: "typescript",
              tsx: "typescript",
              js: "javascript",
              jsx: "javascript",
              py: "python",
              rb: "ruby",
              rs: "rust",
              go: "go",
              java: "java",
              kt: "kotlin",
              swift: "swift",
              dart: "dart",
              c: "c",
              cpp: "cpp",
              h: "c",
              hpp: "cpp",
              cs: "csharp",
              sh: "bash",
              zsh: "bash",
              yml: "yaml",
              yaml: "yaml",
              json: "json",
              toml: "toml",
              md: "markdown",
              html: "html",
              css: "css",
              scss: "css",
              sql: "sql",
              xml: "xml",
              dockerfile: "dockerfile",
              makefile: "makefile",
              gradle: "groovy",
            };
            const language = languageMap[textExt] ?? (textExt || undefined);
            const lines = raw.split("\n");
            const truncated = lines.length > maxLines;
            const content = truncated
              ? lines.slice(0, maxLines).join("\n")
              : raw;
            this.send(ws, {
              type: "file_content",
              ...responseMetadata,
              kind: "text",
              content,
              language,
              totalLines: lines.length,
              truncated,
            });
          } catch (err) {
            this.send(ws, {
              type: "file_content",
              ...responseMetadata,
              content: "",
              error: `Failed to read file: ${err}`,
            });
          }
        })();
        break;
      }

      case "list_files": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "file_list",
            ...projectRequestMetadata(msg),
            files: [],
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        void (async () => {
          try {
            const result = await listProjectFilesAndDirectoriesForClient(
              msg.projectPath,
              {
                maxEntries: this.fileListMaxEntries,
                maxBytes: this.fileListMaxBytes,
              },
            );
            this.send(ws, {
              type: "file_list",
              ...projectRequestMetadata(msg),
              files: result.files,
              ignored: result.ignored,
              modifiedAt: result.modifiedAt,
              totalFiles: result.totalFiles,
              truncated: result.truncated,
            } as Record<string, unknown>);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.send(ws, {
              type: "file_list",
              ...projectRequestMetadata(msg),
              files: [],
              error: `Failed to list files: ${message}`,
            });
          }
        })();
        break;
      }

      case "list_recordings": {
        if (!this.recordingStore) {
          this.send(ws, { type: "recording_list", recordings: [] } as Record<
            string,
            unknown
          >);
          break;
        }
        const store = this.recordingStore;
        void store.listRecordings().then(async (recordings) => {
          // First pass: extract info from JSONL for recordings missing firstPrompt
          // This covers both meta-less legacy recordings and new ones where the
          // metadata file has not been written yet
          await Promise.all(
            recordings.map(async (rec) => {
              const info = await store.extractInfoFromJsonl(rec.name);
              if (info.firstPrompt && !rec.firstPrompt)
                rec.firstPrompt = info.firstPrompt;
              if (info.lastPrompt && !rec.lastPrompt)
                rec.lastPrompt = info.lastPrompt;
              // Backfill meta for legacy recordings
              if (!rec.meta && (info.claudeSessionId || info.projectPath)) {
                rec.meta = {
                  bridgeSessionId: rec.name,
                  claudeSessionId: info.claudeSessionId,
                  projectPath: info.projectPath ?? "",
                  createdAt: rec.modified,
                };
              }
            }),
          );

          // A recording keeps its name snapshot after Project deletion, but a
          // live Project rename should be reflected when the list is read.
          for (const recording of recordings) {
            const projectId = recording.meta?.projectId;
            if (!projectId) continue;
            const project = this.workspaceStore?.getProject(projectId);
            if (project && recording.meta) {
              recording.meta = {
                ...recording.meta,
                projectName: project.name,
              };
            }
          }

          this.send(ws, { type: "recording_list", recordings } as Record<
            string,
            unknown
          >);
        });
        break;
      }

      case "get_recording": {
        if (!this.recordingStore) {
          this.send(ws, {
            type: "error",
            message: "Recording is not enabled on this server",
          });
          break;
        }
        void this.recordingStore
          .getRecordingContent(msg.sessionId)
          .then((content) => {
            if (content !== null) {
              this.send(ws, {
                type: "recording_content",
                sessionId: msg.sessionId,
                content,
              } as Record<string, unknown>);
            } else {
              this.send(ws, {
                type: "error",
                message: `Recording ${msg.sessionId} not found`,
              });
            }
          });
        break;
      }

      case "get_diff": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "diff_result",
            ...projectRequestMetadata(msg),
            staged: msg.staged === true,
            diff: "",
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId)
              .message,
            errorCode: "path_not_allowed",
          });
          break;
        }
        this.collectGitDiff(
          msg.projectPath,
          ({ diff, error }) => {
            if (error) {
              if (/not a git repository/i.test(error)) {
                this.send(ws, {
                  type: "diff_result",
                  ...projectRequestMetadata(msg),
                  staged: msg.staged === true,
                  diff: "",
                  error: "This project is not a git repository",
                  errorCode: "git_not_available",
                });
              } else {
                this.send(ws, {
                  type: "diff_result",
                  ...projectRequestMetadata(msg),
                  staged: msg.staged === true,
                  diff: "",
                  error: `Failed to get diff: ${error}`,
                });
              }
              return;
            }
            void this.collectImageChanges(msg.projectPath, diff).then(
              (imageChanges) => {
                if (imageChanges.length > 0) {
                  this.send(ws, {
                    type: "diff_result",
                    ...projectRequestMetadata(msg),
                    staged: msg.staged === true,
                    diff,
                    imageChanges,
                  });
                } else {
                  this.send(ws, {
                    type: "diff_result",
                    ...projectRequestMetadata(msg),
                    staged: msg.staged === true,
                    diff,
                  });
                }
              },
            );
          },
          msg.staged === true
            ? { staged: true }
            : msg.staged === false
              ? { unstaged: true }
              : undefined,
        );
        break;
      }

      case "get_diff_image": {
        if (
          !this.isPathAllowed(msg.projectPath) ||
          !this.isPathAllowed(resolve(msg.projectPath, msg.filePath))
        ) {
          this.send(ws, {
            type: "diff_image_result",
            ...projectRequestMetadata(msg),
            filePath: msg.filePath,
            version: msg.version,
            error: "Path not allowed",
          });
          break;
        }
        if (msg.version === "both") {
          void (async () => {
            try {
              const [oldResult, newResult] = await Promise.all([
                this.loadDiffImageAsync(msg.projectPath, msg.filePath, "old"),
                this.loadDiffImageAsync(msg.projectPath, msg.filePath, "new"),
              ]);
              const errors = [oldResult.error, newResult.error].filter(Boolean);
              this.send(ws, {
                type: "diff_image_result",
                ...projectRequestMetadata(msg),
                filePath: msg.filePath,
                version: "both" as const,
                oldBase64: oldResult.base64,
                newBase64: newResult.base64,
                mimeType: oldResult.mimeType ?? newResult.mimeType,
                ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
              });
            } catch {
              // WebSocket may have closed; ignore send errors.
            }
          })();
        } else {
          const version = msg.version as "old" | "new";
          void (async () => {
            try {
              const result = await this.loadDiffImageAsync(
                msg.projectPath,
                msg.filePath,
                version,
              );
              this.send(ws, {
                type: "diff_image_result",
                ...projectRequestMetadata(msg),
                filePath: msg.filePath,
                version,
                ...result,
              });
            } catch {
              // WebSocket may have closed; ignore send errors.
            }
          })();
        }
        break;
      }

      case "list_worktrees": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "worktree_list",
            ...projectRequestMetadata(msg),
            worktrees: [],
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          const worktrees = listWorktrees(msg.projectPath);
          const mainBranch = getMainBranch(msg.projectPath);
          this.send(ws, {
            type: "worktree_list",
            ...projectRequestMetadata(msg),
            worktrees,
            mainBranch,
          });
        } catch (err) {
          this.send(ws, {
            type: "worktree_list",
            ...projectRequestMetadata(msg),
            worktrees: [],
            error: `Failed to list worktrees: ${err}`,
          });
        }
        break;
      }

      case "remove_worktree": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "worktree_removed",
            ...projectRequestMetadata(msg),
            worktreePath: msg.worktreePath,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          removeWorktree(msg.projectPath, msg.worktreePath);
          this.worktreeStore.deleteByWorktreePath(msg.worktreePath);
          this.send(ws, {
            type: "worktree_removed",
            ...projectRequestMetadata(msg),
            worktreePath: msg.worktreePath,
          });
        } catch (err) {
          this.send(ws, {
            type: "worktree_removed",
            ...projectRequestMetadata(msg),
            worktreePath: msg.worktreePath,
            error: `Failed to remove worktree: ${err}`,
          });
        }
        break;
      }

      case "git_stage": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_stage_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          if (msg.files?.length) stageFiles(msg.projectPath, msg.files);
          if (msg.hunks?.length) stageHunks(msg.projectPath, msg.hunks);
          this.send(ws, {
            type: "git_stage_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_stage_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_unstage": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_unstage_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          unstageFiles(msg.projectPath, msg.files ?? []);
          this.send(ws, {
            type: "git_unstage_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_unstage_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_unstage_hunks": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_unstage_hunks_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          unstageHunks(msg.projectPath, msg.hunks);
          this.send(ws, {
            type: "git_unstage_hunks_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_unstage_hunks_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_commit": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_commit_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        const piEntry = msg.sessionId
          ? this.piAdapter?.registry.get(msg.sessionId)
          : undefined;
        try {
          const message =
            msg.autoGenerate === true
              ? (() => {
                  if (!msg.sessionId) {
                    throw new Error(
                      "git_commit with autoGenerate=true requires sessionId",
                    );
                  }
                  const requestedPath = resolve(msg.projectPath);
                  if (piEntry) {
                    // pi session: model comes from the pi session registry.
                    const expectedPath = resolve(piEntry.projectId);
                    if (requestedPath !== expectedPath) {
                      throw new Error(
                        "git_commit projectPath must match the active session cwd",
                      );
                    }
                    return generateCommitMessage({
                      projectPath: msg.projectPath,
                      model: piEntry.model,
                    });
                  }
                  throw new Error(`Session ${msg.sessionId} not found`);
                })()
              : msg.message ?? "";
          const result = gitCommit(msg.projectPath, message);
          this.send(ws, {
            type: "git_commit_result",
            ...projectRequestMetadata(msg),
            success: true,
            commitHash: result.hash,
            message: result.message,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_commit_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "git_push": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_push_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          gitPush(msg.projectPath);
          this.send(ws, {
            type: "git_push_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_push_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_branches": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_branches_result",
            ...projectRequestMetadata(msg),
            current: "",
            branches: [],
            checkedOutBranches: [],
            remoteStatusByBranch: {},
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          const result = listBranches(msg.projectPath);
          this.send(ws, {
            type: "git_branches_result",
            ...projectRequestMetadata(msg),
            current: result.current,
            branches: result.branches,
            checkedOutBranches: result.checkedOutBranches,
            remoteStatusByBranch: result.remoteStatusByBranch,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_branches_result",
            ...projectRequestMetadata(msg),
            current: "",
            branches: [],
            remoteStatusByBranch: {},
            error: String(err),
          });
        }
        break;
      }

      case "git_create_branch": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_create_branch_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          createBranch(msg.projectPath, msg.name, msg.checkout);
          this.send(ws, {
            type: "git_create_branch_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_create_branch_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_checkout_branch": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_checkout_branch_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          checkoutBranch(msg.projectPath, msg.branch);
          this.send(ws, {
            type: "git_checkout_branch_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_checkout_branch_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_revert_file": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_revert_file_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          revertFiles(msg.projectPath, msg.files);
          this.send(ws, {
            type: "git_revert_file_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_revert_file_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_revert_hunks": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_revert_hunks_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          revertHunks(msg.projectPath, msg.hunks);
          this.send(ws, {
            type: "git_revert_hunks_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_revert_hunks_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_fetch": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_fetch_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          gitFetch(msg.projectPath);
          this.send(ws, {
            type: "git_fetch_result",
            ...projectRequestMetadata(msg),
            success: true,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_fetch_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_pull": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_pull_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          const result = gitPull(msg.projectPath);
          if (result.success) {
            this.send(ws, {
              type: "git_pull_result",
              ...projectRequestMetadata(msg),
              success: true,
              message: result.message,
            });
          } else {
            this.send(ws, {
              type: "git_pull_result",
              ...projectRequestMetadata(msg),
              success: false,
              error: result.message,
            });
          }
        } catch (err) {
          this.send(ws, {
            type: "git_pull_result",
            ...projectRequestMetadata(msg),
            success: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_status": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_status_result",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            projectPath: msg.projectPath,
            hasUncommittedChanges: false,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            remoteStatusIncluded: false,
            hasRemoteChanges: false,
            commitsAhead: 0,
            commitsBehind: 0,
            hasUpstream: false,
            error: `Path not allowed: ${msg.projectPath}`,
          });
          break;
        }
        try {
          const result = gitStatus(msg.projectPath, {
            includeRemote: msg.includeRemote,
          });
          this.send(ws, {
            type: "git_status_result",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            projectPath: msg.projectPath,
            hasUncommittedChanges: result.hasUncommittedChanges,
            stagedCount: result.stagedCount,
            unstagedCount: result.unstagedCount,
            untrackedCount: result.untrackedCount,
            remoteStatusIncluded: result.remoteStatusIncluded,
            hasRemoteChanges: result.hasRemoteChanges,
            commitsAhead: result.commitsAhead,
            commitsBehind: result.commitsBehind,
            hasUpstream: result.hasUpstream,
            branch: result.branch,
            remoteError: result.remoteError,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_status_result",
            requestId: msg.requestId,
            sessionId: msg.sessionId,
            projectPath: msg.projectPath,
            hasUncommittedChanges: false,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            remoteStatusIncluded: false,
            hasRemoteChanges: false,
            commitsAhead: 0,
            commitsBehind: 0,
            hasUpstream: false,
            error: String(err),
          });
        }
        break;
      }

      case "git_remote_status": {
        if (!this.isPathAllowed(msg.projectPath)) {
          this.send(ws, {
            type: "git_remote_status_result",
            ...projectRequestMetadata(msg),
            ahead: 0,
            behind: 0,
            branch: "",
            hasUpstream: false,
            error: this.buildPathNotAllowedError(msg.projectPath, msg.requestId).message,
          });
          break;
        }
        try {
          const result = gitRemoteStatus(msg.projectPath);
          this.send(ws, {
            type: "git_remote_status_result",
            ...projectRequestMetadata(msg),
            ahead: result.ahead,
            behind: result.behind,
            branch: result.branch,
            hasUpstream: result.hasUpstream,
          });
        } catch (err) {
          this.send(ws, {
            type: "git_remote_status_result",
            ...projectRequestMetadata(msg),
            ahead: 0,
            behind: 0,
            branch: "",
            hasUpstream: false,
          });
        }
        break;
      }

      case "list_windows": {
        listWindows()
          .then((windows) => {
            this.send(ws, { type: "window_list", windows });
          })
          .catch((err) => {
            this.send(ws, {
              type: "error",
              message: `Failed to list windows: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        break;
      }

      case "backup_prompt_history": {
        if (!this.promptHistoryBackup) {
          this.send(ws, {
            type: "prompt_history_backup_result",
            success: false,
            error: "Backup store not available",
          });
          break;
        }
        const buf = Buffer.from(msg.data, "base64");
        this.promptHistoryBackup
          .save(buf, msg.appVersion, msg.dbVersion)
          .then((meta) => {
            this.send(ws, {
              type: "prompt_history_backup_result",
              success: true,
              backedUpAt: meta.backedUpAt,
            });
          })
          .catch((err) => {
            this.send(ws, {
              type: "prompt_history_backup_result",
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      }

      case "restore_prompt_history": {
        if (!this.promptHistoryBackup) {
          this.send(ws, {
            type: "prompt_history_restore_result",
            success: false,
            error: "Backup store not available",
          });
          break;
        }
        this.promptHistoryBackup
          .load()
          .then((result) => {
            if (result) {
              this.send(ws, {
                type: "prompt_history_restore_result",
                success: true,
                data: result.data.toString("base64"),
                appVersion: result.meta.appVersion,
                dbVersion: result.meta.dbVersion,
                backedUpAt: result.meta.backedUpAt,
              });
            } else {
              this.send(ws, {
                type: "prompt_history_restore_result",
                success: false,
                error: "No backup found",
              });
            }
          })
          .catch((err) => {
            this.send(ws, {
              type: "prompt_history_restore_result",
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      }

      case "get_prompt_history_backup_info": {
        if (!this.promptHistoryBackup) {
          this.send(ws, { type: "prompt_history_backup_info", exists: false });
          break;
        }
        this.promptHistoryBackup
          .getMeta()
          .then((meta) => {
            if (meta) {
              this.send(ws, {
                type: "prompt_history_backup_info",
                exists: true,
                ...meta,
              });
            } else {
              this.send(ws, {
                type: "prompt_history_backup_info",
                exists: false,
              });
            }
          })
          .catch(() => {
            this.send(ws, {
              type: "prompt_history_backup_info",
              exists: false,
            });
          });
        break;
      }

      case "record_prompt_history": {
        if (!this.promptHistoryStore) {
          this.send(ws, {
            type: "prompt_history_mutation_result",
            success: false,
            error: "Prompt history store not available",
          });
          break;
        }
        try {
          const piEntry = msg.sessionId
            ? this.piAdapter?.registry.get(msg.sessionId)
            : this.piAdapter?.registry.list().at(-1);
          const workspace = piEntry
            ? {
                projectId: piEntry.projectId,
                projectName: piEntry.name,
              }
            : undefined;
          const entry = await this.promptHistoryStore.record({
            text: msg.text,
            projectPath: msg.projectPath,
            projectId: workspace?.projectId ?? msg.projectId,
            projectName: workspace?.projectName ?? msg.projectName,
            clientId: msg.clientId,
            clientName: msg.clientName,
            sessionId: msg.sessionId,
            usedAt: msg.usedAt,
          });
          this.send(ws, {
            type: "prompt_history_mutation_result",
            success: true,
            bridgeInstanceId: this.promptHistoryStore.bridgeInstanceId,
            revision: this.promptHistoryStore.revision,
            entry,
          });
          this.broadcastPromptHistoryStatus();
        } catch (err) {
          this.send(ws, {
            type: "prompt_history_mutation_result",
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "sync_prompt_history": {
        if (!this.promptHistoryStore) {
          this.send(ws, {
            type: "prompt_history_sync_result",
            success: false,
            error: "Prompt history store not available",
          });
          break;
        }
        try {
          if (msg.entries?.length) {
            await this.promptHistoryStore.mergeClientEntries(msg.entries);
          }
          this.send(ws, {
            type: "prompt_history_sync_result",
            success: true,
            bridgeInstanceId: this.promptHistoryStore.bridgeInstanceId,
            revision: this.promptHistoryStore.revision,
            syncedAt: new Date().toISOString(),
            fullSnapshot: true,
            entries: this.promptHistoryStore.list(msg.includeDeleted ?? true),
          });
          this.broadcastPromptHistoryStatus();
        } catch (err) {
          this.send(ws, {
            type: "prompt_history_sync_result",
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "mutate_prompt_history": {
        if (!this.promptHistoryStore) {
          this.send(ws, {
            type: "prompt_history_mutation_result",
            success: false,
            error: "Prompt history store not available",
          });
          break;
        }
        try {
          const entry = await this.promptHistoryStore.mutate({
            id: msg.id,
            text: msg.text,
            projectPath: msg.projectPath,
            projectId: msg.projectId,
            action: msg.action,
            isFavorite: msg.isFavorite,
            updatedAt: msg.updatedAt,
          });
          this.send(ws, {
            type: "prompt_history_mutation_result",
            success: entry != null,
            bridgeInstanceId: this.promptHistoryStore.bridgeInstanceId,
            revision: this.promptHistoryStore.revision,
            entry: entry ?? undefined,
            error: entry == null ? "Prompt not found" : undefined,
          });
          if (entry) this.broadcastPromptHistoryStatus();
        } catch (err) {
          this.send(ws, {
            type: "prompt_history_mutation_result",
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "import_prompt_history_v1": {
        if (!this.promptHistoryStore) {
          this.send(ws, {
            type: "prompt_history_sync_result",
            success: false,
            error: "Prompt history store not available",
          });
          break;
        }
        try {
          const result = await this.promptHistoryStore.importEntries(
            msg.entries,
            msg.clientId,
            msg.clientName,
          );
          this.send(ws, {
            type: "prompt_history_sync_result",
            success: true,
            bridgeInstanceId: this.promptHistoryStore.bridgeInstanceId,
            revision: this.promptHistoryStore.revision,
            syncedAt: new Date().toISOString(),
            fullSnapshot: true,
            entries: result.entries,
          });
          this.broadcastPromptHistoryStatus();
        } catch (err) {
          this.send(ws, {
            type: "prompt_history_sync_result",
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      default:
        this.send(ws, {
          type: "error",
          errorCode: "unsupported_message",
          message: msg.type,
          requestId: (msg as { requestId?: string }).requestId,
        });
        break;
    }
  }


  // -------------------------------------------------------------------------
  // PI session surface
  //
  // The CC session ops below are served from the pi engine + the pi session
  // files (~/.pi/agent/sessions):
  //   list_sessions / list_recent_sessions -> registry + JSONL scan
  //   resume_session / get_history / get_history_delta / get_session_context
  //   resolve_session_link / rename_session
  // -------------------------------------------------------------------------

  /**
   * PI_HOST=1: handle the CC session surface from the pi engine.
   * Returns true when the op was consumed by the pi adapter.
   */
  private async tryHandlePiSessionOp(
    ws: WebSocket,
    msg: ClientMessage,
  ): Promise<boolean> {
    const adapter = this.piAdapter;
    if (!adapter) return false;

    switch (msg.type) {
      case "list_sessions":
        this.sendPiSessionList(ws);
        return true;
      case "list_recent_sessions": {
        await this.sendPiRecentSessions(
          ws,
          msg as Extract<ClientMessage, { type: "list_recent_sessions" }>,
        );
        return true;
      }
      case "resume_session":
        return this.resumePiSession(
          ws,
          msg as Extract<ClientMessage, { type: "resume_session" }>,
        );
      case "get_history":
        return this.sendPiHistory(
          ws,
          msg as Extract<ClientMessage, { type: "get_history" }>,
        );
      case "get_history_delta":
        return this.sendPiHistorySnapshot(
          ws,
          msg as Extract<ClientMessage, { type: "get_history_delta" }>,
        );
      case "get_session_context":
        return this.sendPiSessionContext(
          ws,
          msg as Extract<ClientMessage, { type: "get_session_context" }>,
        );
      case "resolve_session_link":
        await this.resolvePiSessionLink(
          ws,
          msg as Extract<ClientMessage, { type: "resolve_session_link" }>,
        );
        return true;
      case "rename_session":
        return this.renamePiSession(
          ws,
          msg as Extract<ClientMessage, { type: "rename_session" }>,
        );
      default:
        return false;
    }
  }

  /** CC SessionInfo JSON for a pi registry entry. */
  private piSessionInfoJson(
    entry: PiSessionEntry,
    workspace?: ResolvedWorkspace,
  ): Record<string, unknown> {
    return {
      id: entry.sessionId,
      provider: "pi",
      projectPath: entry.projectId,
      ...(entry.name ? { name: entry.name } : {}),
      status: entry.status,
      createdAt: new Date(entry.createdAt).toISOString(),
      lastActivityAt: new Date(entry.updatedAt).toISOString(),
      ...(entry.model ? { model: entry.model } : {}),
      ...(workspace ? { workspace } : {}),
    };
  }

  /** Session_list for the requesting client (pi runtime sessions). */
  private sendPiSessionList(ws: WebSocket): void {
    const adapter = this.piAdapter;
    if (!adapter) return;
    const sessions = adapter.registry.list().map((entry) => {
      const workspace = this.workspaceForPiProject(entry.projectId);
      return this.piSessionInfoJson(entry, workspace);
    });
    this.send(ws, {
      type: "session_list",
      sessions,
      allowedDirs: this.allowedDirs,
      bridgeVersion: getPackageVersion(),
      protocolVersion: BRIDGE_PROTOCOL_MAX_VERSION,
      minimumProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
      protocolCapabilities: [
        "project_request_correlation_v1",
        "session_context_v1",
      ],
    });
  }

  /** Broadcast session_list to all connected clients (pi runtime sessions). */
  private broadcastPiSessionList(): void {
    const adapter = this.piAdapter;
    if (!adapter) return;
    const sessions = adapter.registry.list().map((entry) => {
      const workspace = this.workspaceForPiProject(entry.projectId);
      return this.piSessionInfoJson(entry, workspace);
    });
    this.broadcast({
      type: "session_list",
      sessions,
      allowedDirs: this.allowedDirs,
      bridgeVersion: getPackageVersion(),
      protocolVersion: BRIDGE_PROTOCOL_MAX_VERSION,
      minimumProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
      protocolCapabilities: [
        "project_request_correlation_v1",
        "session_context_v1",
      ],
    });
  }

  /** Resolve a ResolvedWorkspace for a pi project path, if a project matches. */
  private workspaceForPiProject(projectId: string): ResolvedWorkspace | undefined {
    if (!this.workspaceStore) return undefined;
    const project = this.workspaceStore.getProject(projectId);
    if (!project) return undefined;
    const normalized = this.normalizeWorkspaceRoots(project.rootPaths);
    if (!normalized.roots) return undefined;
    return {
      kind: "project",
      projectId: project.id,
      projectName: project.name,
      rootPaths: normalized.roots,
    };
  }

  /** CC RecentSession JSON from a pi session file summary. */
  private piRecentSessionJson(meta: PiSessionMeta): Record<string, unknown> {
    return {
      sessionId: meta.sessionId,
      provider: "pi",
      ...(meta.name ? { name: meta.name } : {}),
      firstPrompt: meta.name ?? "",
      created: meta.createdAt,
      modified: meta.lastActivityAt,
      projectPath: meta.cwd,
      resumeCwd: meta.cwd,
      isSidechain: false,
    };
  }

  /** list_recent_sessions: recent pi sessions from ~/.pi/agent/sessions. */
  private async sendPiRecentSessions(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "list_recent_sessions" }>,
  ): Promise<void> {
    const adapter = this.piAdapter;
    if (!adapter) return;
    try {
      const metas = await scanPiRecentSessions(adapter.gateway.piHome);
      const sessions = metas.map((meta) => this.piRecentSessionJson(meta));
      this.send(ws, {
        type: "recent_sessions",
        sessions,
        hasMore: false,
        limit: msg.limit,
        offset: msg.offset,
      });
    } catch (err) {
      console.error("[ws] Failed to scan pi recent sessions:", err);
      this.send(ws, {
        type: "error",
        requestId: msg.requestId,
        errorCode: "recent_sessions_failed",
        message: `Failed to load pi recent sessions: ${err}`,
      });
    }
  }

  /**
   * resume_session: open a pi session from the home/recent list. The engine
   * persists its own session per cwd, so resuming is: resolve the cwd, warm
   * the engine, register the bridge session, then hand the app a
   * session_created + status so it navigates and replays get_history.
   */
  private async resumePiSession(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "resume_session" }>,
  ): Promise<boolean> {
    const adapter = this.piAdapter;
    if (!adapter) return true;
    const raw = msg as Record<string, unknown>;
    const sourceSessionId = String(raw.sessionId ?? "");
    let projectPath = String(raw.projectPath ?? "");
    if (projectPath === "") {
      const metas = await scanPiRecentSessions(adapter.gateway.piHome);
      const meta = metas.find((m) => m.sessionId === sourceSessionId);
      if (!meta) {
        this.sendPiResumeFailed(ws, msg, sourceSessionId);
        return true;
      }
      projectPath = meta.cwd;
    }
    projectPath = resolvePlatformPath(projectPath, this.platform);
    if (!this.isPathAllowed(projectPath)) {
      this.sendPiResumeFailed(ws, msg, sourceSessionId);
      this.send(ws, this.buildPathNotAllowedError(projectPath));
      return true;
    }
    // The app correlates get_history/input by sessionId; use the source id
    // so resume -> history replay round-trips on the same key.
    const sessionId = sourceSessionId;
    adapter.registry.register(sessionId, projectPath, "idle");
    adapter.bind(ws, projectPath);
    const state = await adapter.warm(projectPath);
    if (isFailedEngineResponse(state)) {
      this.sendPiResumeFailed(ws, msg, sourceSessionId);
      this.send(ws, {
        type: "error",
        sessionId,
        message: state.error,
      });
      return true;
    }
    const entry = adapter.registry.get(sessionId);
    this.send(ws, {
      type: "system",
      subtype: "session_created",
      sessionId,
      provider: "pi",
      projectPath,
      status: "idle",
      ...(entry?.model ? { model: entry.model } : {}),
    } as Record<string, unknown>);
    this.send(ws, {
      type: "status",
      status: "idle",
      sessionId,
    } as Record<string, unknown>);
    this.broadcastPiSessionList();
    return true;
  }

  private sendPiResumeFailed(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "resume_session" }>,
    sourceSessionId: string,
  ): void {
    this.send(ws, {
      type: "system",
      subtype: "session_resume_failed",
      sourceSessionId,
      resumeRequestId: msg.resumeRequestId,
      provider: "pi",
    } as Record<string, unknown>);
  }

  /** Resolve the pi project for a session id (registry first, then disk). */
  private async piProjectForSession(sessionId: string): Promise<string> {
    const adapter = this.piAdapter;
    if (!adapter) return "";
    const entry = adapter.registry.get(sessionId);
    if (entry !== undefined) return entry.projectId;
    const metas = await scanPiRecentSessions(adapter.gateway.piHome);
    const meta = metas.find((m) => m.sessionId === sessionId);
    return meta?.cwd ?? "";
  }

  /**
   * get_history: full conversation from the pi engine (get_messages) converted
   * to CC history messages, followed by the current engine status.
   */
  private async sendPiHistory(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "get_history" }>,
  ): Promise<boolean> {
    const adapter = this.piAdapter;
    if (!adapter) return true;
    const sessionId = msg.sessionId;
    if (!sessionId) return false;
    const projectId = await this.piProjectForSession(sessionId);
    if (projectId === "") {
      this.send(ws, {
        type: "error",
        sessionId,
        errorCode: "session_not_found",
        message: `Session ${sessionId} not found`,
      });
      return true;
    }
    const result = await adapter.gateway
      .handleControl({ type: "control", op: "get_messages", projectId })
      .catch(() => undefined);
    if (isFailedEngineResponse(result)) {
      this.send(ws, {
        type: "error",
        sessionId,
        message: result.error,
      });
      return true;
    }
    const data = (result as Record<string, unknown> | null)?.["data"] as
      | Record<string, unknown>
      | undefined;
    const rawMessages = Array.isArray(data?.["messages"])
      ? (data["messages"] as unknown[])
      : [];
    // The engine only holds loaded sessions in memory; fall back to the
    // on-disk JSONL so history works for every session in the list.
    const messages =
      rawMessages.length > 0
        ? piMessagesToHistoryMessages(rawMessages)
        : await this.loadSessionHistoryFromDisk(projectId, sessionId);
    this.send(ws, {
      type: "history",
      sessionId,
      messages,
    } as Record<string, unknown>);
    const entry = adapter.registry.get(sessionId);
    this.send(ws, {
      type: "status",
      sessionId,
      status: entry?.status ?? "idle",
    } as Record<string, unknown>);
    return true;
  }

  /**
   * get_history_delta: pi has no incremental history deltas; the engine
   * streams its own live events. Serve a full snapshot (the app treats
   * history_snapshot as a full replacement, which is always correct).
   */
  private async sendPiHistorySnapshot(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "get_history_delta" }>,
  ): Promise<boolean> {
    const adapter = this.piAdapter;
    if (!adapter) return true;
    const sessionId = msg.sessionId;
    if (!sessionId) return false;
    const projectId = await this.piProjectForSession(sessionId);
    if (projectId === "") {
      this.send(ws, {
        type: "error",
        sessionId,
        message: `Session ${sessionId} not found`,
      });
      return true;
    }
    const result = await adapter.gateway
      .handleControl({ type: "control", op: "get_messages", projectId })
      .catch(() => undefined);
    if (isFailedEngineResponse(result)) {
      this.send(ws, {
        type: "error",
        sessionId,
        message: result.error,
      });
      return true;
    }
    const data = (result as Record<string, unknown> | null)?.["data"] as
      | Record<string, unknown>
      | undefined;
    const rawMessages = Array.isArray(data?.["messages"])
      ? (data["messages"] as unknown[])
      : [];
    const messages =
      rawMessages.length > 0
        ? piMessagesToHistoryMessages(rawMessages)
        : await this.loadSessionHistoryFromDisk(projectId, sessionId);
    const entries = messages.map((message, index) => ({
      seq: index + 1,
      message,
    }));
    const entry = adapter.registry.get(sessionId);
    this.send(ws, {
      type: "history_snapshot",
      sessionId,
      fromSeq: 0,
      toSeq: entries.length,
      entries,
      status: entry?.status ?? "idle",
      reason: "snapshot",
    } as Record<string, unknown>);
    return true;
  }

  /**
   * Disk fallback for history: locate the pi session JSONL under the pi home
   * and convert its stored messages, so unloaded (inactive) sessions still
   * replay their full conversation.
   */
  private async loadSessionHistoryFromDisk(
    projectId: string,
    sessionId: string,
  ): Promise<PiHistoryMessage[]> {
    const adapter = this.piAdapter;
    if (!adapter) return [];
    try {
      const metas = await scanPiRecentSessions(adapter.gateway.piHome);
      const meta = metas.find(
        (m) => m.sessionId === sessionId && m.cwd === projectId,
      );
      if (!meta) return [];
      const content = await readFile(meta.filePath, "utf8");
      return piSessionFileToHistoryMessages(content);
    } catch (err) {
      console.error(
        `[ws] Failed to load session history from disk: ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * get_message_images: extract base64 images from the pi session JSONL
   * (the session id the app sends is the pi session id). Correlates to a
   * specific message when the app passes a pi message id; otherwise returns
   * all user-message images in the session.
   */
  private async loadPiSessionImages(
    sessionId: string | undefined,
    messageUuid: string | undefined,
  ): Promise<PiSessionImage[]> {
    if (!sessionId) return [];
    const adapter = this.piAdapter;
    if (!adapter) return [];
    try {
      const entry = adapter.registry.get(sessionId);
      const metas = await scanPiRecentSessions(adapter.gateway.piHome);
      const meta =
        entry !== undefined
          ? metas.find((m) => m.cwd === entry.projectId)
          : metas.find((m) => m.sessionId === sessionId);
      if (!meta) return [];
      const content = await readFile(meta.filePath, "utf8");
      return piSessionImagesFromJsonl(content, messageUuid);
    } catch (err) {
      console.error(
        `[ws] Failed to load pi session images: ${String(err)}`,
      );
      return [];
    }
  }

  /** get_session_context: runtime pi session summary from the registry. */
  private sendPiSessionContext(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "get_session_context" }>,
  ): boolean {
    const adapter = this.piAdapter;
    if (!adapter) return true;
    const entry = adapter.registry.get(msg.sessionId);
    if (!entry) {
      this.send(ws, {
        type: "error",
        sessionId: msg.sessionId,
        errorCode: "session_not_found",
        message: `Session ${msg.sessionId} not found`,
      });
      return true;
    }
    const workspace = this.workspaceForPiProject(entry.projectId);
    this.send(ws, {
      type: "session_context",
      sessionId: msg.sessionId,
      context: this.piSessionInfoJson(entry, workspace),
    });
    return true;
  }

  /** resolve_session_link: live pi runtime session or a recent pi session. */
  private async resolvePiSessionLink(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "resolve_session_link" }>,
  ): Promise<void> {
    const adapter = this.piAdapter;
    if (!adapter) return;
    const sourceSessionId = msg.sessionId;
    const live = adapter.registry.get(sourceSessionId);
    if (live) {
      this.send(ws, {
        type: "session_link_resolution",
        requestId: msg.requestId,
        sourceSessionId,
        status: "live",
        bridgeSessionId: live.sessionId,
        provider: "pi",
      } as Record<string, unknown>);
      return;
    }
    try {
      const metas = await scanPiRecentSessions(adapter.gateway.piHome);
      const meta = metas.find((m) => m.sessionId === sourceSessionId);
      this.send(ws, {
        type: "session_link_resolution",
        requestId: msg.requestId,
        sourceSessionId,
        status: meta ? "recent" : "unavailable",
        provider: "pi",
        ...(meta ? { recentSession: this.piRecentSessionJson(meta) } : {}),
      } as Record<string, unknown>);
    } catch {
      this.send(ws, {
        type: "session_link_resolution",
        requestId: msg.requestId,
        sourceSessionId,
        status: "unavailable",
        provider: "pi",
      } as Record<string, unknown>);
    }
  }

  /** rename_session: forward to the pi engine (set_session_name). */
  private async renamePiSession(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "rename_session" }>,
  ): Promise<boolean> {
    const adapter = this.piAdapter;
    if (!adapter) return true;
    const sessionId = msg.sessionId;
    const name = msg.name ?? "";
    const projectId = await this.piProjectForSession(sessionId);
    if (projectId === "") {
      this.send(ws, { type: "rename_result", sessionId, name, success: false });
      return true;
    }
    if (!adapter.registry.get(sessionId)) {
      adapter.registry.register(sessionId, projectId, "idle");
    }
    const result = await adapter.gateway
      .handleControl({
        type: "control",
        op: "set_session_name",
        projectId,
        payload: { name },
      })
      .catch(() => undefined);
    const ok = !isFailedEngineResponse(result);
    if (ok) {
      adapter.registry.rename(sessionId, name);
    }
    this.send(ws, { type: "rename_result", sessionId, name, success: ok });
    this.broadcastPiSessionList();
    return true;
  }


  private sendPromptHistoryStatus(ws: WebSocket): void {
    if (!this.promptHistoryStore) return;
    const entries = this.promptHistoryStore.list(true);
    const updatedAt = entries.reduce<string | undefined>(
      (latest, entry) =>
        !latest || entry.updatedAt > latest ? entry.updatedAt : latest,
      undefined,
    );
    this.send(ws, {
      type: "prompt_history_status",
      bridgeInstanceId: this.promptHistoryStore.bridgeInstanceId,
      revision: this.promptHistoryStore.revision,
      entryCount: entries.filter((entry) => !entry.deletedAt).length,
      updatedAt,
    });
  }

  /** Broadcast session list to all connected clients. */

  private broadcastPromptHistoryStatus(): void {
    if (!this.promptHistoryStore) return;
    const entries = this.promptHistoryStore.list(true);
    const updatedAt = entries.reduce<string | undefined>(
      (latest, entry) =>
        !latest || entry.updatedAt > latest ? entry.updatedAt : latest,
      undefined,
    );
    this.broadcast({
      type: "prompt_history_status",
      bridgeInstanceId: this.promptHistoryStore.bridgeInstanceId,
      revision: this.promptHistoryStore.revision,
      entryCount: entries.filter((entry) => !entry.deletedAt).length,
      updatedAt,
    });
  }


  /** Broadcast a session-scoped server message, batching stream deltas. */
  private broadcastSessionMessage(
    sessionId: string,
    msg: ServerMessage,
    exclude?: WebSocket,
  ): void {
    if (this.shouldBatchDelta(msg, exclude)) {
      this.trackSessionMessage(sessionId, msg);
      const chunks = this.splitDeltaText(msg.text);
      for (const client of this.wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (!this.shouldSendToClient(client, msg)) continue;
        this.queueDeltaForClient(client, sessionId, msg.type, chunks);
      }
      return;
    }

    this.flushSessionDeltaBatches(sessionId);
    this.trackSessionMessage(sessionId, msg);
    this.broadcastSessionMessageNow(sessionId, msg, exclude);
  }

  private trackSessionMessage(sessionId: string, msg: ServerMessage): void {
    this.recordDebugEvent(sessionId, {
      direction: "outgoing",
      channel: "session",
      type: msg.type,
      detail: this.summarizeServerMessage(msg),
    });
    this.recordingStore?.record(sessionId, "outgoing", msg);
  }

  private broadcastSessionMessageNow(
    sessionId: string,
    msg: ServerMessage,
    exclude?: WebSocket,
  ): void {
    for (const client of this.wss.clients) {
      if (client === exclude) continue;
      if (client.readyState === WebSocket.OPEN) {
        const outboundMsg = {
          ...(msg as unknown as Record<string, unknown>),
          sessionId,
        };
        const compatibleMsg = this.prepareServerMessageForClient(
          client,
          outboundMsg,
        );
        if (!compatibleMsg) continue;
        client.send(JSON.stringify(compatibleMsg));
      }
    }
  }

  private shouldBatchDelta(
    msg: ServerMessage,
    exclude?: WebSocket,
  ): msg is DeltaServerMessage {
    if (this.deltaBatchMs === 0 || exclude) return false;
    return msg.type === "stream_delta" || msg.type === "thinking_delta";
  }

  private queueDeltaForClient(
    client: WebSocket,
    sessionId: string,
    type: DeltaServerMessage["type"],
    chunks: DeltaTextChunk[],
  ): void {
    for (const chunk of chunks) {
      let batch = this.deltaBatches.get(client)?.get(sessionId);
      if (
        batch &&
        batch.charCount > 0 &&
        batch.charCount + chunk.charCount > this.deltaBatchMaxChars
      ) {
        this.flushClientDeltaBatch(client, sessionId);
        batch = undefined;
      }

      if (!batch) {
        const clientBatches = this.deltaBatches.get(client) ?? new Map();
        batch = {
          messages: [],
          charCount: 0,
          timer: setTimeout(() => {
            this.flushClientDeltaBatch(client, sessionId);
          }, this.deltaBatchMs),
        };
        clientBatches.set(sessionId, batch);
        this.deltaBatches.set(client, clientBatches);
      }

      const last = batch.messages.at(-1);
      if (last?.type === type) {
        last.text += chunk.text;
      } else {
        batch.messages.push({ type, text: chunk.text });
      }
      batch.charCount += chunk.charCount;

      if (batch.charCount >= this.deltaBatchMaxChars) {
        this.flushClientDeltaBatch(client, sessionId);
      }
    }
  }

  private splitDeltaText(text: string): DeltaTextChunk[] {
    if (text.length === 0) return [{ text, charCount: 0 }];

    const chunks: DeltaTextChunk[] = [];
    let chars: string[] = [];
    let charCount = 0;
    for (const char of text) {
      chars.push(char);
      charCount += 1;
      if (charCount >= this.deltaBatchMaxChars) {
        chunks.push({ text: chars.join(""), charCount });
        chars = [];
        charCount = 0;
      }
    }
    if (chars.length > 0) {
      chunks.push({ text: chars.join(""), charCount });
    }
    return chunks;
  }

  private flushSessionDeltaBatches(sessionId: string): void {
    for (const client of Array.from(this.deltaBatches.keys())) {
      this.flushClientDeltaBatch(client, sessionId);
    }
  }

  private flushAllDeltaBatches(): void {
    for (const [client, batches] of Array.from(this.deltaBatches.entries())) {
      for (const sessionId of Array.from(batches.keys())) {
        this.flushClientDeltaBatch(client, sessionId);
      }
    }
  }

  private flushClientDeltaBatch(client: WebSocket, sessionId: string): void {
    const clientBatches = this.deltaBatches.get(client);
    const batch = clientBatches?.get(sessionId);
    if (!batch) return;

    clearTimeout(batch.timer);
    clientBatches?.delete(sessionId);
    if (clientBatches?.size === 0) this.deltaBatches.delete(client);
    if (client.readyState !== WebSocket.OPEN) return;

    for (const msg of batch.messages) {
      client.send(JSON.stringify({ ...msg, sessionId }));
    }
  }

  private discardClientDeltaBatches(client: WebSocket): void {
    const batches = this.deltaBatches.get(client);
    if (!batches) return;
    for (const batch of batches.values()) clearTimeout(batch.timer);
    this.deltaBatches.delete(client);
  }


  private normalizeWorkspaceRoots(rootPaths: string[]): {
    roots?: string[];
    deniedRoot?: string;
  } {
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const rawPath of rootPaths) {
      const path = resolvePlatformPath(rawPath, this.platform);
      if (!this.isPathAllowed(path)) return { deniedRoot: rawPath };
      if (!seen.has(path)) {
        seen.add(path);
        roots.push(path);
      }
    }
    return roots.length > 0 ? { roots } : {};
  }


  private projectsMessage(requestId?: string): ServerMessage {
    return {
      type: "projects",
      projects: this.workspaceStore?.listProjects() ?? [],
      ...(requestId ? { requestId } : {}),
    };
  }

  private sendWorkspaceMutationError(
    ws: WebSocket,
    requestId: string | undefined,
    action: string,
    error: unknown,
  ): void {
    this.send(ws, {
      type: "error",
      requestId,
      errorCode: "workspace_write_failed",
      message: `Failed to ${action}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  private legacyProjectHistoryProjects(): string[] {
    return this.projectHistory?.getProjects() ?? [];
  }


  private broadcast(msg: Record<string, unknown>): void {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        const compatibleMsg = this.prepareServerMessageForClient(client, msg);
        if (!compatibleMsg) continue;
        client.send(JSON.stringify(compatibleMsg));
      }
    }
  }

  private prepareServerMessageForClient(
    ws: WebSocket,
    msg: ServerMessage | Record<string, unknown>,
  ): ServerMessage | Record<string, unknown> | null {
    if (!this.shouldSendToClient(ws, msg)) return null;
    if (!("messages" in msg) || !Array.isArray(msg.messages)) return msg;
    const messages = msg.messages as unknown[];

    if (msg.type === "history") {
      return {
        ...(msg as unknown as Record<string, unknown>),
        messages: messages.filter(
          (message) =>
            isRecord(message) && this.shouldSendToClient(ws, message),
        ),
      };
    }
    if (msg.type === "history_delta" || msg.type === "history_snapshot") {
      return {
        ...(msg as unknown as Record<string, unknown>),
        messages: messages.filter((entry) => {
          if (!isRecord(entry) || !isRecord(entry.message)) return true;
          return this.shouldSendToClient(ws, entry.message);
        }),
      };
    }
    return msg;
  }

  private shouldSendToClient(
    ws: WebSocket,
    msg: ServerMessage | Record<string, unknown>,
  ): boolean {
    const type = typeof msg.type === "string" ? msg.type : "";
    if (!OPT_IN_SERVER_MESSAGES.has(type)) return true;
    return (
      this.clientSupportedServerMessages.get(ws)?.has(type) ?? false
    );
  }


  private send(
    ws: WebSocket,
    msg: ServerMessage | Record<string, unknown>,
  ): void {
    const compatibleMsg = this.prepareServerMessageForClient(ws, msg);
    if (!compatibleMsg) return;
    const sessionId = this.extractSessionIdFromServerMessage(compatibleMsg);
    if (sessionId && this.debugEvents.has(sessionId)) {
      this.recordDebugEvent(sessionId, {
        direction: "outgoing",
        channel: "ws",
        type: String(compatibleMsg.type ?? "unknown"),
        detail: this.summarizeOutboundMessage(compatibleMsg),
      });
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(compatibleMsg));
    }
  }

  /** Broadcast a gallery_new_image message to all connected clients. */
  broadcastGalleryNewImage(
    image: import("./gallery-store.js").GalleryImageInfo,
  ): void {
    this.broadcast({ type: "gallery_new_image", image });
  }

  private collectGitDiff(
    cwd: string,
    callback: (result: { diff: string; error?: string }) => void,
    options?: { staged?: boolean; unstaged?: boolean },
  ): void {
    const execOpts = { cwd, maxBuffer: 10 * 1024 * 1024 };
    const gitArgs = (...args: string[]) => [
      "-c",
      "core.quotePath=false",
      ...args,
    ];
    const listUntrackedFiles = () => {
      const out = execFileSync(
        "git",
        gitArgs("ls-files", "-z", "--others", "--exclude-standard"),
        { cwd, encoding: "utf-8" },
      );
      return out.split("\0").filter(Boolean);
    };

    // Staged only: git diff --cached
    if (options?.staged) {
      execFile(
        "git",
        gitArgs("diff", "--cached", "--no-color"),
        execOpts,
        (err, stdout) => {
          if (err) {
            callback({ diff: "", error: err.message });
            return;
          }
          callback({ diff: stdout });
        },
      );
      return;
    }

    // Unstaged only: git diff (working tree vs index) — original behavior
    if (options?.unstaged) {
      // Collect untracked files so they appear in the diff.
      let untrackedFiles: string[] = [];
      try {
        untrackedFiles = listUntrackedFiles();
      } catch {
        // Ignore errors: non-git directories are handled by git diff callback.
      }

      // Temporarily stage untracked files with --intent-to-add.
      if (untrackedFiles.length > 0) {
        try {
          execFileSync(
            "git",
            ["add", "--intent-to-add", "--", ...untrackedFiles],
            {
              cwd,
            },
          );
        } catch {
          // Ignore staging errors.
        }
      }

      execFile(
        "git",
        gitArgs("diff", "--no-color"),
        execOpts,
        (err, stdout) => {
          // Revert intent-to-add for untracked files.
          if (untrackedFiles.length > 0) {
            try {
              execFileSync("git", ["reset", "--", ...untrackedFiles], { cwd });
            } catch {
              // Ignore reset errors.
            }
          }

          if (err) {
            callback({ diff: "", error: err.message });
            return;
          }
          callback({ diff: stdout });
        },
      );
      return;
    }

    // All mode (no options): git diff HEAD — shows both staged and unstaged vs HEAD
    let untrackedFilesAll: string[] = [];
    try {
      untrackedFilesAll = listUntrackedFiles();
    } catch {
      // Ignore
    }

    if (untrackedFilesAll.length > 0) {
      try {
        execFileSync(
          "git",
          ["add", "--intent-to-add", "--", ...untrackedFilesAll],
          {
            cwd,
          },
        );
      } catch {
        // Ignore
      }
    }

    execFile(
      "git",
      gitArgs("diff", "HEAD", "--no-color"),
      execOpts,
      (err, stdout) => {
        if (untrackedFilesAll.length > 0) {
          try {
            execFileSync("git", ["reset", "--", ...untrackedFilesAll], { cwd });
          } catch {
            // Ignore
          }
        }

        if (err) {
          callback({ diff: "", error: err.message });
          return;
        }
        callback({ diff: stdout });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Image diff helpers
  // ---------------------------------------------------------------------------

  private static readonly IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".bmp",
    ".svg",
  ]);

  private static readonly FILE_PEEK_IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
  ]);

  // Image diff thresholds (configurable via environment variables)
  // - Auto-display: images ≤ threshold are sent inline as base64
  // - Max size: images ≤ max are available for on-demand loading
  // - Images > max size show text info only
  private static readonly AUTO_DISPLAY_THRESHOLD = (() => {
    const kb = parseInt(process.env.DIFF_IMAGE_AUTO_DISPLAY_KB ?? "", 10);
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : 1024 * 1024; // default 1 MB
  })();
  private static readonly MAX_IMAGE_SIZE = (() => {
    const mb = parseInt(process.env.DIFF_IMAGE_MAX_SIZE_MB ?? "", 10);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 5 * 1024 * 1024; // default 5 MB
  })();

  private static mimeTypeForExt(ext: string): string {
    const map: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
    };
    return map[ext.toLowerCase()] ?? "application/octet-stream";
  }

  /**
   * Scan diff text for image file changes and extract base64 data where appropriate.
   *
   * Detection strategy:
   * 1. Binary markers: "Binary files a/<path> and b/<path> differ"
   * 2. diff --git headers where the file extension is an image type
   *
   * For each detected image file:
   * - Old version: `git show HEAD:<path>` (committed version)
   * - New version: read from working tree
   * - Apply size thresholds for auto-display / on-demand / text-only
   */
  private async collectImageChanges(
    cwd: string,
    diffText: string,
  ): Promise<ImageChange[]> {
    // Phase 1: Extract image file entries from diff text (synchronous, CPU only)
    interface ImageEntry {
      filePath: string;
      isNew: boolean;
      isDeleted: boolean;
      isSvg: boolean;
      mimeType: string;
      ext: string;
    }
    const entries: ImageEntry[] = [];
    const processedPaths = new Set<string>();

    const lines = diffText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (!gitMatch) continue;

      const filePath = gitMatch[2];
      const ext = extname(filePath).toLowerCase();
      if (!BridgeWebSocketServer.IMAGE_EXTENSIONS.has(ext)) continue;
      if (processedPaths.has(filePath)) continue;
      processedPaths.add(filePath);

      let isNew = false;
      let isDeleted = false;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (lines[j].startsWith("diff --git ")) break;
        if (lines[j].startsWith("new file mode")) isNew = true;
        if (lines[j].startsWith("deleted file mode")) isDeleted = true;
      }

      entries.push({
        filePath,
        isNew,
        isDeleted,
        isSvg: ext === ".svg",
        mimeType: BridgeWebSocketServer.mimeTypeForExt(ext),
        ext,
      });
    }

    if (entries.length === 0) return [];

    // Phase 2: Read image data asynchronously
    const execFileAsync = promisify(execFile);

    const changes: ImageChange[] = [];
    for (const entry of entries) {
      let oldBuf: Buffer | undefined;
      let newBuf: Buffer | undefined;

      // Read old image (committed version)
      if (!entry.isNew) {
        try {
          const result = await execFileAsync(
            "git",
            ["show", `HEAD:${entry.filePath}`],
            {
              cwd,
              maxBuffer: BridgeWebSocketServer.MAX_IMAGE_SIZE + 1024,
              encoding: "buffer",
            },
          );
          oldBuf = result.stdout as unknown as Buffer;
        } catch {
          // File may not exist in HEAD (e.g. untracked)
        }
      }

      // Read new image (working tree)
      if (!entry.isDeleted) {
        try {
          const absPath = resolve(cwd, entry.filePath);
          if (existsSync(absPath)) {
            newBuf = await readFile(absPath);
          }
        } catch {
          // Ignore read errors
        }
      }

      const oldSize = oldBuf?.length;
      const newSize = newBuf?.length;
      const maxSize = Math.max(oldSize ?? 0, newSize ?? 0);

      const autoDisplay =
        maxSize <= BridgeWebSocketServer.AUTO_DISPLAY_THRESHOLD;
      const loadable =
        autoDisplay || maxSize <= BridgeWebSocketServer.MAX_IMAGE_SIZE;

      const change: ImageChange = {
        filePath: entry.filePath,
        isNew: entry.isNew,
        isDeleted: entry.isDeleted,
        isSvg: entry.isSvg,
        mimeType: entry.mimeType,
        loadable,
        autoDisplay: autoDisplay || undefined,
      };

      if (oldSize !== undefined) change.oldSize = oldSize;
      if (newSize !== undefined) change.newSize = newSize;

      // Auto-display images are no longer embedded in the initial response.
      // They are loaded on-demand when the Flutter widget becomes visible.

      changes.push(change);
    }

    return changes;
  }

  /**
   * Load a single diff image on demand (async I/O for better throughput).
   */
  private async loadDiffImageAsync(
    cwd: string,
    filePath: string,
    version: "old" | "new",
  ): Promise<{ base64?: string; mimeType?: string; error?: string }> {
    // Path traversal guard: reject paths containing '..' or absolute paths
    if (filePath.includes("..") || filePath.startsWith("/")) {
      return { error: "Invalid file path" };
    }

    const ext = extname(filePath).toLowerCase();
    if (!BridgeWebSocketServer.IMAGE_EXTENSIONS.has(ext)) {
      return { error: "Not an image file" };
    }
    const mimeType = BridgeWebSocketServer.mimeTypeForExt(ext);

    try {
      const execFileAsync = promisify(execFile);

      let buf: Buffer;
      if (version === "old") {
        const result = await execFileAsync(
          "git",
          ["show", `HEAD:${filePath}`],
          {
            cwd,
            maxBuffer: BridgeWebSocketServer.MAX_IMAGE_SIZE + 1024,
            encoding: "buffer",
          },
        );
        buf = result.stdout as unknown as Buffer;
      } else {
        const absPath = resolve(cwd, filePath);
        // Verify resolved path stays within cwd
        if (!isPathWithinAllowedDirectory(absPath, cwd, this.platform)) {
          return { error: "Invalid file path" };
        }
        buf = await readFile(absPath);
      }

      if (buf.length > BridgeWebSocketServer.MAX_IMAGE_SIZE) {
        return { error: "Image too large" };
      }

      return { base64: buf.toString("base64"), mimeType };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private extractSessionIdFromClientMessage(
    msg: ClientMessage,
  ): string | undefined {
    return "sessionId" in msg && typeof msg.sessionId === "string"
      ? msg.sessionId
      : undefined;
  }

  private extractSessionIdFromServerMessage(
    msg: ServerMessage | Record<string, unknown>,
  ): string | undefined {
    if ("sessionId" in msg && typeof msg.sessionId === "string")
      return msg.sessionId;
    return undefined;
  }

  private recordDebugEvent(
    sessionId: string,
    event: Omit<DebugTraceEvent, "ts" | "sessionId">,
  ): void {
    const events = this.debugEvents.get(sessionId) ?? [];
    const fullEvent: DebugTraceEvent = {
      ts: new Date().toISOString(),
      sessionId,
      ...event,
    };
    events.push(fullEvent);
    if (events.length > BridgeWebSocketServer.MAX_DEBUG_EVENTS) {
      events.splice(0, events.length - BridgeWebSocketServer.MAX_DEBUG_EVENTS);
    }
    this.debugEvents.set(sessionId, events);
    this.debugTraceStore.record(fullEvent);
  }

  private getDebugEvents(sessionId: string, limit: number): DebugTraceEvent[] {
    const events = this.debugEvents.get(sessionId) ?? [];
    const capped = Math.max(
      0,
      Math.min(limit, BridgeWebSocketServer.MAX_DEBUG_EVENTS),
    );
    if (capped === 0) return [];
    return events.slice(-capped);
  }


  private summarizeClientMessage(msg: ClientMessage): string {
    switch (msg.type) {
      case "input": {
        const textPreview = msg.text.replace(/\s+/g, " ").trim().slice(0, 80);
        const hasImage = msg.imageBase64 != null || msg.imageId != null;
        return `text=\"${textPreview}\" image=${hasImage} skills=${msg.skills?.length ?? (msg.skill ? 1 : 0)} mentions=${msg.mentions?.length ?? 0}`;
      }
      case "approve":
      case "approve_always":
      case "reject":
        return `id=${msg.id}`;
      case "answer":
        return `toolUseId=${msg.toolUseId}`;
      case "install_tool_suggestion":
        return `toolUseId=${msg.toolUseId}`;
      case "start":
        return `projectPath=${msg.projectPath} provider=${msg.provider ?? "pi"}`;
      case "resume_session":
        return `sessionId=${msg.sessionId} provider=${msg.provider ?? "pi"}`;
      case "get_debug_bundle":
        return `traceLimit=${msg.traceLimit ?? BridgeWebSocketServer.MAX_DEBUG_EVENTS} includeDiff=${msg.includeDiff ?? true}`;
      case "get_usage":
        return "get_usage";
      default:
        return msg.type;
    }
  }

  private summarizeServerMessage(msg: ServerMessage): string {
    switch (msg.type) {
      case "assistant": {
        const textChunks: string[] = [];
        for (const content of msg.message.content) {
          if (content.type === "text") {
            textChunks.push(content.text);
          }
        }
        const text = textChunks
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100);
        return text ? `assistant: ${text}` : "assistant";
      }
      case "tool_result": {
        const contentPreview = msg.content
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100);
        return `${msg.toolName ?? "tool_result"}(${msg.toolUseId}) ${contentPreview}`;
      }
      case "permission_request":
        return `${msg.toolName}(${msg.toolUseId})`;
      case "result":
        return `${msg.subtype}${msg.error ? ` error=${msg.error}` : ""}`;
      case "status":
        return msg.status;
      case "error":
        return msg.message;
      case "stream_delta":
      case "thinking_delta":
        return `${msg.type}(${msg.text.length})`;
      default:
        return msg.type;
    }
  }

  private summarizeOutboundMessage(
    msg: ServerMessage | Record<string, unknown>,
  ): string {
    if ("type" in msg && typeof msg.type === "string") {
      return msg.type;
    }
    return "message";
  }
}
