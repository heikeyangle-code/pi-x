import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePlatformPath } from "./path-utils.js";
import { MediaStore } from "./media-store.js";
import { UploadStore } from "./upload-store.js";

const { generateCommitMessageMock, gitCommitMock } = vi.hoisted(() => ({
  generateCommitMessageMock: vi.fn(),
  gitCommitMock: vi.fn(),
}));

vi.mock("./debug-trace-store.js", () => ({
  DebugTraceStore: class MockDebugTraceStore {
    init() {
      return Promise.resolve();
    }

    getTraceFilePath(sessionId: string) {
      return `/tmp/${sessionId}.jsonl`;
    }

    getBundleFilePath(sessionId: string, generatedAt: string) {
      return `/tmp/${sessionId}-${generatedAt}.json`;
    }

    saveBundle(sessionId: string, generatedAt: string) {
      return this.getBundleFilePath(sessionId, generatedAt);
    }

    saveBundleAtPath() {}

    record() {}
  },
}));

vi.mock("./git-assist.js", () => ({
  generateCommitMessage: generateCommitMessageMock,
}));

vi.mock("./git-operations.js", async () => {
  const actual = await vi.importActual<typeof import("./git-operations.js")>(
    "./git-operations.js",
  );
  return {
    ...actual,
    gitCommit: gitCommitMock,
  };
});


import { BridgeWebSocketServer, downloadMimeType } from "./websocket.js";
import { PiAdapter } from "./pi-host/pi-adapter.js";

describe("downloadMimeType", () => {
  it("recognizes common deliverables and falls back safely", () => {
    expect(downloadMimeType("report.pdf")).toBe("application/pdf");
    expect(downloadMimeType("archive.zip")).toBe("application/zip");
    expect(downloadMimeType("audio.wav")).toBe("audio/wav");
    expect(downloadMimeType("audio.MP3")).toBe("audio/mpeg");
    expect(downloadMimeType("video.mkv")).toBe("video/x-matroska");
    expect(downloadMimeType("unknown.ccpocket")).toBe(
      "application/octet-stream",
    );
  });
});

describe("BridgeWebSocketServer resume/get_history flow", () => {
  const OPEN_STATE = 1;
  let httpServer: ReturnType<typeof createServer>;
  let originalFetch: typeof globalThis.fetch;

  /** Minimal PiGatewayLike stand-in (no real pi spawn). */
  function fakeGateway() {
    return {
      handleControl: vi.fn(async () => ({ ok: true })),
      respondUi: vi.fn(() => true),
      stopAll: vi.fn(async () => {}),
      piHome: "/tmp/pi-home",
    };
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    httpServer = createServer();
    generateCommitMessageMock.mockReset();
    gitCommitMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    httpServer.close();
  });

  it("echoes gallery request correlation and canonical project path", async () => {
    const list = vi.fn().mockReturnValue([]);
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      galleryStore: { list } as any,
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    await (bridge as any).handleClientMessage(
      {
        type: "list_gallery",
        projectPath: "/tmp/project-a",
        project: "/tmp/project-a",
        sessionId: "session-a",
        requestId: "gallery-1",
      },
      ws,
    );

    expect(list).toHaveBeenCalledWith({
      projectPath: "/tmp/project-a",
      sessionId: "session-a",
    });
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      type: "gallery_list",
      images: [],
      projectPath: "/tmp/project-a",
      sessionId: "session-a",
      requestId: "gallery-1",
    });

    bridge.close();
  });

  it("uses the current Project name when listing existing recordings", async () => {
    const recordingStore = {
      init: vi.fn().mockResolvedValue(undefined),
      listRecordings: vi.fn().mockResolvedValue([
        {
          name: "recording-1",
          path: "/tmp/recording-1.jsonl",
          modified: "2026-09-01T00:00:00.000Z",
          sizeBytes: 10,
          meta: {
            bridgeSessionId: "recording-1",
            projectPath: "/tmp/project",
            projectId: "project-1",
            projectName: "Old name",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        },
      ]),
      extractInfoFromJsonl: vi.fn().mockResolvedValue({}),
    };
    const workspaceStore = {
      getProject: vi.fn(() => ({
        id: "project-1",
        name: "Current name",
        rootPaths: ["/tmp/project"],
      })),
    };
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      recordingStore: recordingStore as any,
      workspaceStore: workspaceStore as any,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    await (bridge as any).handleClientMessage({ type: "list_recordings" }, ws);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

    const message = ws.send.mock.calls
      .map((call: unknown[]) => JSON.parse(call[0] as string))
      .find((item: any) => item.type === "recording_list");
    expect(message.recordings[0].meta.projectName).toBe("Current name");

    bridge.close();
  });

  it("suppresses conversation_queue for clients that did not opt in", async () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;
    const msg = {
      type: "conversation_queue",
      sessionId: "s-1",
      limit: 1,
      items: [],
    };

    (bridge as any).send(ws, msg);
    expect(ws.send).not.toHaveBeenCalled();

    await (bridge as any).handleClientMessage(
      {
        type: "client_capabilities",
        supportedServerMessages: ["conversation_queue"],
      },
      ws,
    );
    (bridge as any).send(ws, msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));

    bridge.close();
  });

  it("advertises the supported protocol range in session lists", () => {
    const adapter = new PiAdapter({ gateway: fakeGateway() });
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      piAdapter: adapter,
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    (bridge as any).sendPiSessionList(ws);

    const message = JSON.parse(ws.send.mock.calls[0][0]);
    expect(message).toMatchObject({
      type: "session_list",
      protocolVersion: 1,
      minimumProtocolVersion: 1,
    });
    bridge.close();
  });
  it("rejects clients without an overlapping protocol version", async () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
      close: vi.fn(),
    } as any;

    await (bridge as any).handleClientMessage(
      {
        type: "client_capabilities",
        protocolVersion: 2,
        minimumProtocolVersion: 2,
      },
      ws,
    );

    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "error",
      errorCode: "incompatible_protocol",
      protocolVersion: 1,
      minimumProtocolVersion: 1,
    });
    expect(ws.close).toHaveBeenCalledWith(
      4406,
      "Incompatible protocol version",
    );

    ws.send.mockClear();
    await (bridge as any).handleClientMessage(
      { type: "list_sessions" },
      ws,
    );
    expect(ws.send).not.toHaveBeenCalled();
    bridge.close();
  });

  it("fails closed when client protocol metadata is malformed", () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const handlers = new Map<string, (data?: unknown) => void>();
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, handler: (data?: unknown) => void) => {
        handlers.set(event, handler);
      }),
    } as any;
    (bridge as any).handleConnection(ws);
    ws.send.mockClear();

    handlers.get("message")!(
      Buffer.from(
        JSON.stringify({
          type: "client_capabilities",
          minimumProtocolVersion: 1,
        }),
      ),
    );

    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "error",
      errorCode: "incompatible_protocol",
      protocolVersion: 1,
      minimumProtocolVersion: 1,
    });
    expect(ws.close).toHaveBeenCalledWith(
      4406,
      "Incompatible protocol version",
    );
    bridge.close();
  });

  it("suppresses guardian approvals unless the client opts in", async () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;
    const msg = {
      type: "guardian_approval",
      risk: "medium",
      reason: "Writes build files outside the workspace.",
    };

    (bridge as any).send(ws, msg);
    expect(ws.send).not.toHaveBeenCalled();

    await (bridge as any).handleClientMessage(
      {
        type: "client_capabilities",
        supportedServerMessages: ["guardian_approval"],
      },
      ws,
    );
    (bridge as any).send(ws, msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));

    bridge.close();
  });

  it("filters guardian approvals from history for legacy clients", () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;
    const msg = {
      type: "history_delta",
      fromSeq: 1,
      toSeq: 2,
      messages: [
        { seq: 1, message: { type: "status", status: "running" } },
        {
          seq: 2,
          message: {
            type: "guardian_approval",
            risk: "high",
            reason: "Changes files outside the workspace.",
          },
        },
      ],
    };

    (bridge as any).send(ws, msg);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ...msg, messages: [msg.messages[0]] }),
    );
    bridge.close();
  });

  it("suppresses prompt_history_status for clients that did not opt in", async () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;
    const msg = {
      type: "prompt_history_status",
      bridgeInstanceId: "bridge-1",
      revision: 1,
      entryCount: 2,
    };

    (bridge as any).send(ws, msg);
    expect(ws.send).not.toHaveBeenCalled();

    await (bridge as any).handleClientMessage(
      {
        type: "client_capabilities",
        supportedServerMessages: ["prompt_history_status"],
      },
      ws,
    );
    (bridge as any).send(ws, msg);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));

    bridge.close();
  });

  it("limits file list payloads and reports truncation", async () => {
    const repo = mkdtempSync(resolve(tmpdir(), "ccpocket-file-list-"));
    try {
      execFileSync("git", ["init"], { cwd: repo });
      writeFileSync(resolve(repo, "a.ts"), "a\n");
      writeFileSync(resolve(repo, "b.ts"), "b\n");
      writeFileSync(resolve(repo, "c.ts"), "c\n");
      const bridge = new BridgeWebSocketServer({
        server: httpServer,
        fileListMaxEntries: 2,
        fileListMaxBytes: 1024,
      });
      const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

      await (bridge as any).handleClientMessage(
        { type: "list_files", projectPath: repo, requestId: "files-1" },
        ws,
      );
      for (let i = 0; i < 50 && ws.send.mock.calls.length === 0; i++) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      const message = ws.send.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((sent: { type: string }) => sent.type === "file_list");
      expect(message).toMatchObject({
        type: "file_list",
        projectPath: repo,
        requestId: "files-1",
        truncated: true,
      });
      expect(message.files).toHaveLength(2);
      expect(message.ignored).toEqual([false, false]);
      expect(message.modifiedAt).toEqual({});
      expect(message.totalFiles).toBeUndefined();
      bridge.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns correlated operation results for disallowed project paths", async () => {
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: ["/allowed"],
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    await (bridge as any).handleClientMessage(
      {
        type: "list_files",
        projectPath: "/denied",
        requestId: "file-list-1",
      },
      ws,
    );
    await (bridge as any).handleClientMessage(
      {
        type: "git_push",
        projectPath: "/denied",
        requestId: "git-push-1",
      },
      ws,
    );

    const messages = ws.send.mock.calls.map((call: unknown[]) =>
      JSON.parse(call[0] as string),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "file_list",
        projectPath: "/denied",
        requestId: "file-list-1",
        files: [],
        error: expect.stringContaining("Project path not allowed"),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "git_push_result",
        projectPath: "/denied",
        requestId: "git-push-1",
        success: false,
        error: expect.stringContaining("Project path not allowed"),
      }),
    );
    bridge.close();
  });

  it("lists only visible allowed directories", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ccpocket-directory-request-"));
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [root],
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    try {
      mkdirSync(resolve(root, "zeta"));
      mkdirSync(resolve(root, "alpha"));
      mkdirSync(resolve(root, ".hidden"));
      writeFileSync(resolve(root, "file.txt"), "file");

      await (bridge as any).handleClientMessage(
        { type: "list_directory", path: root, requestId: "dir-success" },
        ws,
      );

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "directory_listing",
          path: root,
          directories: [
            { name: "alpha", path: resolve(root, "alpha") },
            { name: "zeta", path: resolve(root, "zeta") },
          ],
          requestId: "dir-success",
        }),
      );
    } finally {
      bridge.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists hidden allowed directories when requested", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ccpocket-directory-hidden-"));
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [root],
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    try {
      mkdirSync(resolve(root, ".hidden"));

      await (bridge as any).handleClientMessage(
        { type: "list_directory", path: root, includeHidden: true },
        ws,
      );

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "directory_listing",
          path: root,
          directories: [
            { name: ".hidden", path: resolve(root, ".hidden") },
          ],
        }),
      );
    } finally {
      bridge.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects directory listing requests that resolve outside allowed roots", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ccpocket-directory-root-"));
    const outside = mkdtempSync(resolve(tmpdir(), "ccpocket-directory-outside-"));
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [root],
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    try {
      await (bridge as any).handleClientMessage(
        { type: "list_directory", path: outside, requestId: "dir-error" },
        ws,
      );

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "error",
          errorCode: "directory_not_allowed",
          message: "Directory path is outside the allowed roots",
          path: outside,
          requestId: "dir-error",
        }),
      );
    } finally {
      bridge.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns unstaged diff for mixed ASCII and non-ASCII untracked paths", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-diff-"));
    execFileSync("git", ["init"], { cwd: projectPath });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: projectPath,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: projectPath });
    writeFileSync(resolve(projectPath, "initial.txt"), "initial\n");
    execFileSync("git", ["add", "initial.txt"], { cwd: projectPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: projectPath });
    mkdirSync(resolve(projectPath, "docs"));
    writeFileSync(resolve(projectPath, "docs", "啊.md"), "hello\n");
    writeFileSync(resolve(projectPath, "normal.txt"), "normal\n");

    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "get_diff",
          projectPath,
          staged: false,
          requestId: "diff-1",
        },
        ws,
      );

      await expect
        .poll(() =>
          ws.send.mock.calls
            .map((c: unknown[]) => JSON.parse(c[0] as string))
            .find((m: any) => m.type === "diff_result"),
        )
        .toBeDefined();

      const diffResult = ws.send.mock.calls
        .map((c: unknown[]) => JSON.parse(c[0] as string))
        .find((m: any) => m.type === "diff_result");
      expect(diffResult.error).toBeUndefined();
      expect(diffResult).toMatchObject({
        projectPath,
        requestId: "diff-1",
        staged: false,
      });
      expect(diffResult.diff).toContain("diff --git a/docs/啊.md b/docs/啊.md");
      expect(diffResult.diff).toContain("diff --git a/normal.txt b/normal.txt");
      expect(diffResult.diff).not.toContain("\\345\\225");
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("returns all diff for mixed staged and non-ASCII untracked paths", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-diff-"));
    execFileSync("git", ["init"], { cwd: projectPath });
    execFileSync("git", ["config", "user.email", "test@test.com"], {
      cwd: projectPath,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: projectPath });
    writeFileSync(resolve(projectPath, "initial.txt"), "initial\n");
    execFileSync("git", ["add", "initial.txt"], { cwd: projectPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: projectPath });
    writeFileSync(resolve(projectPath, "initial.txt"), "changed\n");
    execFileSync("git", ["add", "initial.txt"], { cwd: projectPath });
    mkdirSync(resolve(projectPath, "docs"));
    writeFileSync(resolve(projectPath, "docs", "啊.md"), "hello\n");

    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "get_diff",
          projectPath,
        },
        ws,
      );

      await expect
        .poll(() =>
          ws.send.mock.calls
            .map((c: unknown[]) => JSON.parse(c[0] as string))
            .find((m: any) => m.type === "diff_result"),
        )
        .toBeDefined();

      const diffResult = ws.send.mock.calls
        .map((c: unknown[]) => JSON.parse(c[0] as string))
        .find((m: any) => m.type === "diff_result");
      expect(diffResult.error).toBeUndefined();
      expect(diffResult.diff).toContain("diff --git a/initial.txt b/initial.txt");
      expect(diffResult.diff).toContain("diff --git a/docs/啊.md b/docs/啊.md");
      expect(diffResult.diff).not.toContain("\\345\\225");
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("returns base64 image data for image file peek", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-bridge-"));
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    writeFileSync(resolve(projectPath, "pixel.png"), Buffer.from(pngBase64, "base64"));

    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "read_file",
          projectPath,
          filePath: "pixel.png",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);

      const sends = ws.send.mock.calls.map((c: unknown[]) =>
        JSON.parse(c[0] as string),
      );
      expect(sends).toContainEqual({
        type: "file_content",
        projectPath,
        filePath: "pixel.png",
        kind: "image",
        content: "",
        base64: pngBase64,
        mimeType: "image/png",
        sizeBytes: Buffer.from(pngBase64, "base64").length,
      });
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps text file peek responses as text content", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-bridge-"));
    writeFileSync(resolve(projectPath, "README.md"), "# Hello\n\nWorld\n");

    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "read_file",
          projectPath,
          filePath: "README.md",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);

      const sends = ws.send.mock.calls.map((c: unknown[]) =>
        JSON.parse(c[0] as string),
      );
      expect(sends).toContainEqual({
        type: "file_content",
        projectPath,
        filePath: "README.md",
        kind: "text",
        content: "# Hello\n\nWorld\n",
        language: "markdown",
        totalLines: 4,
        truncated: false,
      });
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it.each([
    ["sample.wav", "audio", "audio/wav"],
    ["sample.mp3", "audio", "audio/mpeg"],
    ["sample.m4a", "audio", "audio/mp4"],
    ["sample.aac", "audio", "audio/aac"],
    ["sample.flac", "audio", "audio/flac"],
    ["sample.ogg", "audio", "audio/ogg"],
    ["sample.opus", "audio", "audio/ogg"],
    ["sample.aif", "audio", "audio/aiff"],
    ["sample.aiff", "audio", "audio/aiff"],
    ["sample.aifc", "audio", "audio/aiff"],
    ["sample.mp4", "video", "video/mp4"],
    ["sample.mov", "video", "video/quicktime"],
    ["sample.m4v", "video", "video/x-m4v"],
    ["sample.webm", "video", "video/webm"],
    ["sample.mkv", "video", "video/x-matroska"],
    ["sample.avi", "video", "video/x-msvideo"],
    ["sample.mpg", "video", "video/mpeg"],
    ["sample.mpeg", "video", "video/mpeg"],
  ])("returns a streaming URL for %s file peek", async (fileName, kind, mimeType) => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-bridge-"));
    const contents = Buffer.from("generated media contents");
    writeFileSync(resolve(projectPath, fileName), contents);
    const mediaStore = new MediaStore();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
      mediaStore,
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "read_file",
          projectPath,
          filePath: fileName,
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);
      const response = ws.send.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((message: any) => message.type === "file_content");

      expect(response).toMatchObject({
        type: "file_content",
        filePath: fileName,
        kind,
        content: "",
        mimeType,
        sizeBytes: contents.length,
      });
      expect(response.mediaUrl).toMatch(/^\/api\/media\/[a-f0-9]{48}$/);
      expect(response.base64).toBeUndefined();
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects media symlinks whose targets escape the allowed directory", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-bridge-"));
    const outsidePath = mkdtempSync(resolve(tmpdir(), "ccpocket-media-outside-"));
    writeFileSync(resolve(outsidePath, "private.mp4"), "private");
    symlinkSync(resolve(outsidePath, "private.mp4"), resolve(projectPath, "linked.mp4"));
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
      mediaStore: new MediaStore(),
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "read_file",
          projectPath,
          filePath: "linked.mp4",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);
      const sends = ws.send.mock.calls.map((call: unknown[]) =>
        JSON.parse(call[0] as string),
      );
      expect(sends).toContainEqual({
        type: "file_content",
        projectPath,
        filePath: "linked.mp4",
        content: "",
        error: "Path not allowed",
      });
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it("prepares a capability URL for downloading a regular project file", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-download-"));
    const contents = Buffer.from("generated report");
    writeFileSync(resolve(projectPath, "report.pdf"), contents);
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
      mediaStore: new MediaStore(),
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "prepare_file_download",
          projectPath,
          filePath: "report.pdf",
          requestId: "download-1",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);
      const response = ws.send.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((message: any) => message.type === "file_download_ready");
      expect(response).toMatchObject({
        type: "file_download_ready",
        requestId: "download-1",
        filePath: "report.pdf",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: contents.length,
      });
      expect(response.downloadUrl).toMatch(/^\/api\/media\/[a-f0-9]{48}$/);
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("prepares a capability URL for uploading into the current project folder", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-upload-"));
    mkdirSync(resolve(projectPath, "docs"));
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
      uploadStore: new UploadStore(),
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "prepare_file_upload",
          projectPath,
          directoryPath: "docs",
          fileName: "report.pdf",
          sizeBytes: 123,
          conflictPolicy: "rename",
          requestId: "upload-1",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);
      const response = ws.send.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((message: any) => message.type === "file_upload_ready");
      expect(response).toMatchObject({
        type: "file_upload_ready",
        requestId: "upload-1",
        fileName: "report.pdf",
        sizeBytes: 123,
      });
      expect(response.uploadUrl).toMatch(/^\/api\/uploads\/[a-f0-9]{48}$/);
      expect(response.uploadToken).toMatch(/^[a-f0-9]{48}$/);
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects unsafe upload destinations, names, and configured size overflow", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ccpocket-upload-root-"));
    const projectPath = resolve(root, "project");
    mkdirSync(projectPath);
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [root],
      uploadStore: new UploadStore(),
      fileUploadMaxBytes: 4,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    try {
      for (const [directoryPath, fileName, sizeBytes, requestId] of [
        ["..", "report.pdf", 1, "upload-escape"],
        ["", "../private.txt", 1, "upload-name"],
        ["", "large.zip", 5, "upload-large"],
      ] as const) {
        await (bridge as any).handleClientMessage(
          {
            type: "prepare_file_upload",
            projectPath,
            directoryPath,
            fileName,
            sizeBytes,
            conflictPolicy: "rename",
            requestId,
          },
          ws,
        );
      }
      await expect.poll(() => ws.send.mock.calls.length).toBe(3);
      const errors = ws.send.mock.calls.map((call: unknown[]) =>
        JSON.parse(call[0] as string),
      );
      expect(errors.map((error: any) => error.errorCode)).toEqual([
        "file_upload_not_allowed",
        "file_upload_not_allowed",
        "file_upload_too_large",
      ]);
    } finally {
      bridge.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects downloads that escape the selected project", async () => {
    const allowedRoot = mkdtempSync(resolve(tmpdir(), "ccpocket-download-root-"));
    const projectPath = resolve(allowedRoot, "project");
    mkdirSync(projectPath);
    writeFileSync(resolve(allowedRoot, "private.txt"), "private");
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [allowedRoot],
      mediaStore: new MediaStore(),
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "prepare_file_download",
          projectPath,
          filePath: "../private.txt",
          requestId: "download-escape",
        },
        ws,
      );

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "error",
          errorCode: "file_download_not_allowed",
          message: "The requested file is outside the current project.",
          path: "../private.txt",
          requestId: "download-escape",
        }),
      );
    } finally {
      bridge.close();
      rmSync(allowedRoot, { recursive: true, force: true });
    }
  });

  it("rejects download symlinks whose targets escape the project", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-download-"));
    const outsidePath = mkdtempSync(resolve(tmpdir(), "ccpocket-download-outside-"));
    writeFileSync(resolve(outsidePath, "private.wav"), "private");
    symlinkSync(resolve(outsidePath, "private.wav"), resolve(projectPath, "linked.wav"));
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
      mediaStore: new MediaStore(),
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "prepare_file_download",
          projectPath,
          filePath: "linked.wav",
          requestId: "download-symlink",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);
      const response = ws.send.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((message: any) => message.type === "error");
      expect(response).toMatchObject({
        errorCode: "file_download_not_allowed",
        path: "linked.wav",
        requestId: "download-symlink",
      });
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it("rejects downloads larger than the configured limit", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-download-"));
    writeFileSync(resolve(projectPath, "large.zip"), "12345");
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
      mediaStore: new MediaStore(),
      fileDownloadMaxBytes: 4,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;

    try {
      await (bridge as any).handleClientMessage(
        {
          type: "prepare_file_download",
          projectPath,
          filePath: "large.zip",
          requestId: "download-large",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);
      const response = ws.send.mock.calls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((message: any) => message.type === "error");
      expect(response).toMatchObject({
        errorCode: "file_download_too_large",
        path: "large.zip",
        requestId: "download-large",
      });
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("returns a friendly error for symbolic links to directories", async () => {
    const projectPath = mkdtempSync(resolve(tmpdir(), "ccpocket-bridge-"));
    const targetDir = resolve(projectPath, "target-dir");
    const symlinkPath = resolve(projectPath, "linked-dir");
    mkdirSync(targetDir);
    symlinkSync("target-dir", symlinkPath);

    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      allowedDirs: [projectPath],
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    try {
      (bridge as any).handleClientMessage(
        {
          type: "read_file",
          projectPath,
          filePath: "linked-dir",
        },
        ws,
      );

      await expect.poll(() => ws.send.mock.calls.length).toBeGreaterThan(0);

      const sends = ws.send.mock.calls.map((c: unknown[]) =>
        JSON.parse(c[0] as string),
      );
      expect(sends).toContainEqual({
        type: "file_content",
        projectPath,
        filePath: "linked-dir",
        content: "",
        error:
          "This symbolic link points to a directory (target-dir). Open the target directory instead.",
      });
    } finally {
      bridge.close();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("returns debug_bundle for an active session", async () => {
    const adapter = new PiAdapter({ gateway: fakeGateway() });
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      piAdapter: adapter,
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;
    adapter.registry.register("pi-session-debug", "/tmp/project-a", "idle");

    (bridge as any).handleClientMessage(
      {
        type: "get_debug_bundle",
        sessionId: "pi-session-debug",
        includeDiff: false,
        traceLimit: 50,
      },
      ws,
    );
    await Promise.resolve();

    const bundle = JSON.parse(ws.send.mock.calls.at(-1)?.[0] as string);
    expect(bundle.type).toBe("debug_bundle");
    expect(bundle.sessionId).toBe("pi-session-debug");
    expect(bundle.session).toMatchObject({
      id: "pi-session-debug",
      status: "idle",
      projectPath: "/tmp/project-a",
    });
    expect(Array.isArray(bundle.debugTrace)).toBe(true);
    expect(typeof bundle.traceFilePath).toBe("string");
    expect(typeof bundle.savedBundlePath).toBe("string");

    bridge.close();
  });
  it("does not create debug trace buckets for unknown session ids", () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    (bridge as any).handleClientMessage(
      {
        type: "set_permission_mode",
        sessionId: "missing-session",
        mode: "plan",
      },
      ws,
    );

    expect((bridge as any).debugEvents.size).toBe(0);
    bridge.close();
  });

  it("batches deltas for clients that were connected when each delta arrived", () => {
    vi.useFakeTimers();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
    });
    const first = { readyState: OPEN_STATE, send: vi.fn() } as any;
    const late = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(first);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "before ",
    });
    (bridge as any).wss.clients.add(late);
    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "after",
    });
    vi.advanceTimersByTime(100);

    expect(first.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(first.send.mock.calls[0][0] as string)).toEqual({
      type: "stream_delta",
      text: "before after",
      sessionId: "s-1",
    });
    expect(late.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(late.send.mock.calls[0][0] as string)).toEqual({
      type: "stream_delta",
      text: "after",
      sessionId: "s-1",
    });

    bridge.close();
  });

  it("flushes alternating deltas before a non-delta session message", () => {
    vi.useFakeTimers();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(ws);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "answer ",
    });
    (bridge as any).broadcastSessionMessage("s-1", {
      type: "thinking_delta",
      text: "thought",
    });
    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "done",
    });
    (bridge as any).broadcastSessionMessage("s-1", {
      type: "status",
      status: "idle",
    });

    expect(
      ws.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string)),
    ).toEqual([
      { type: "stream_delta", text: "answer ", sessionId: "s-1" },
      { type: "thinking_delta", text: "thought", sessionId: "s-1" },
      { type: "stream_delta", text: "done", sessionId: "s-1" },
      { type: "status", status: "idle", sessionId: "s-1" },
    ]);
    vi.advanceTimersByTime(100);
    expect(ws.send).toHaveBeenCalledTimes(4);

    bridge.close();
  });

  it("keeps batches isolated by session", () => {
    vi.useFakeTimers();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(ws);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "one",
    });
    (bridge as any).broadcastSessionMessage("s-2", {
      type: "stream_delta",
      text: "two",
    });
    (bridge as any).broadcastSessionMessage("s-1", {
      type: "status",
      status: "idle",
    });

    expect(
      ws.send.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string)),
    ).toEqual([
      { type: "stream_delta", text: "one", sessionId: "s-1" },
      { type: "status", status: "idle", sessionId: "s-1" },
    ]);
    vi.advanceTimersByTime(100);
    expect(JSON.parse(ws.send.mock.calls[2][0] as string)).toEqual({
      type: "stream_delta",
      text: "two",
      sessionId: "s-2",
    });

    bridge.close();
  });

  it("splits oversized deltas without breaking Unicode characters", () => {
    vi.useFakeTimers();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
      deltaBatchMaxChars: 2,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(ws);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "A😀BC",
    });
    vi.advanceTimersByTime(100);

    const messages = ws.send.mock.calls.map((call: unknown[]) =>
      JSON.parse(call[0] as string),
    );
    expect(messages.map((message: { text: string }) => message.text).join(""))
      .toBe("A😀BC");
    expect(
      messages.every(
        (message: { text: string }) => Array.from(message.text).length <= 2,
      ),
    ).toBe(true);

    bridge.close();
  });

  it("flushes pending deltas before excluding a client from a later delta", () => {
    vi.useFakeTimers();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
    });
    const included = { readyState: OPEN_STATE, send: vi.fn() } as any;
    const excluded = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(included);
    (bridge as any).wss.clients.add(excluded);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "first",
    });
    (bridge as any).broadcastSessionMessage(
      "s-1",
      { type: "stream_delta", text: "second" },
      excluded,
    );

    expect(
      included.send.mock.calls.map((call: unknown[]) =>
        JSON.parse(call[0] as string),
      ),
    ).toEqual([
      { type: "stream_delta", text: "first", sessionId: "s-1" },
      { type: "stream_delta", text: "second", sessionId: "s-1" },
    ]);
    expect(JSON.parse(excluded.send.mock.calls[0][0] as string)).toEqual({
      type: "stream_delta",
      text: "first",
      sessionId: "s-1",
    });

    bridge.close();
  });

  it("discards pending deltas when a client disconnects", () => {
    vi.useFakeTimers();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(ws);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "discarded",
    });
    (bridge as any).discardClientDeltaBatches(ws);
    vi.advanceTimersByTime(100);

    expect(ws.send).not.toHaveBeenCalled();

    bridge.close();
  });

  it("records original deltas immediately instead of recording batches", () => {
    vi.useFakeTimers();
    const recordingStore = {
      init: vi.fn(async () => {}),
      record: vi.fn(),
      saveMeta: vi.fn(),
    };
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
      recordingStore: recordingStore as any,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(ws);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "a",
    });
    (bridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "b",
    });

    expect(recordingStore.record.mock.calls).toEqual([
      ["s-1", "outgoing", { type: "stream_delta", text: "a" }],
      ["s-1", "outgoing", { type: "stream_delta", text: "b" }],
    ]);
    expect(ws.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(JSON.parse(ws.send.mock.calls[0][0] as string).text).toBe("ab");

    bridge.close();
  });

  it("supports disabled batching and strict environment defaults", () => {
    vi.stubEnv("BRIDGE_DELTA_BATCH_MS", "100ms");
    vi.stubEnv("BRIDGE_DELTA_BATCH_MAX_CHARS", "-1");
    const fallbackBridge = new BridgeWebSocketServer({ server: httpServer });
    expect((fallbackBridge as any).deltaBatchMs).toBe(100);
    expect((fallbackBridge as any).deltaBatchMaxChars).toBe(4096);
    fallbackBridge.close();

    vi.stubEnv("BRIDGE_DELTA_BATCH_MS", "3000000000");
    const overflowBridge = new BridgeWebSocketServer({ server: httpServer });
    expect((overflowBridge as any).deltaBatchMs).toBe(100);
    overflowBridge.close();

    const overflowOptionBridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 3_000_000_000,
    });
    expect((overflowOptionBridge as any).deltaBatchMs).toBe(100);
    overflowOptionBridge.close();

    const disabledBridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 0,
    });
    const ws = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (disabledBridge as any).wss.clients.add(ws);
    (disabledBridge as any).broadcastSessionMessage("s-1", {
      type: "stream_delta",
      text: "now",
    });
    expect(JSON.parse(ws.send.mock.calls[0][0] as string).text).toBe("now");
    disabledBridge.close();
  });

  it("flushes every client batch during shutdown", () => {
    vi.useFakeTimers();
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      deltaBatchMs: 100,
    });
    const first = { readyState: OPEN_STATE, send: vi.fn() } as any;
    const second = { readyState: OPEN_STATE, send: vi.fn() } as any;
    (bridge as any).wss.clients.add(first);
    (bridge as any).wss.clients.add(second);

    (bridge as any).broadcastSessionMessage("s-1", {
      type: "thinking_delta",
      text: "closing",
    });
    bridge.close();

    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
  });

  it("rejects git_commit autoGenerate without sessionId", async () => {
    const bridge = new BridgeWebSocketServer({ server: httpServer });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;

    (bridge as any).handleClientMessage(
      {
        type: "git_commit",
        projectPath: "/tmp/project-a",
        autoGenerate: true,
      },
      ws,
    );

    const sends = ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(sends).toContainEqual({
      type: "git_commit_result",
      projectPath: "/tmp/project-a",
      success: false,
      error: "git_commit with autoGenerate=true requires sessionId",
    });

    bridge.close();
  });

  it("rejects git_commit autoGenerate when projectPath does not match session cwd", async () => {
    const adapter = new PiAdapter({ gateway: fakeGateway() });
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      piAdapter: adapter,
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;
    adapter.registry.register("pi-session-1", "/tmp/project-a", "idle");

    (bridge as any).handleClientMessage(
      {
        type: "git_commit",
        sessionId: "pi-session-1",
        projectPath: "/tmp/other-project",
        autoGenerate: true,
      },
      ws,
    );
    await Promise.resolve();

    const sends = ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(sends).toContainEqual({
      type: "git_commit_result",
      projectPath: "/tmp/other-project",
      success: false,
      error: "git_commit projectPath must match the active session cwd",
    });

    bridge.close();
  });
  it("auto-generates commit message for a pi session", async () => {
    generateCommitMessageMock.mockReturnValue("feat: generated by pi");
    gitCommitMock.mockReturnValue({
      hash: "abc1234",
      message: "feat: generated by pi",
    });

    const adapter = new PiAdapter({ gateway: fakeGateway() });
    const bridge = new BridgeWebSocketServer({
      server: httpServer,
      piAdapter: adapter,
    });
    const ws = {
      readyState: OPEN_STATE,
      send: vi.fn(),
    } as any;
    adapter.registry.register("pi-session-1", "/tmp/project-a", "idle");

    (bridge as any).handleClientMessage(
      {
        type: "git_commit",
        sessionId: "pi-session-1",
        projectPath: "/tmp/project-a",
        autoGenerate: true,
      },
      ws,
    );
    await Promise.resolve();

    expect(generateCommitMessageMock).toHaveBeenCalledWith({
      projectPath: "/tmp/project-a",
      model: undefined,
    });
    expect(gitCommitMock).toHaveBeenCalledWith(
      "/tmp/project-a",
      "feat: generated by pi",
    );

    const sends = ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(sends).toContainEqual({
      type: "git_commit_result",
      projectPath: "/tmp/project-a",
      success: true,
      commitHash: "abc1234",
      message: "feat: generated by pi",
    });

    bridge.close();
  });
});
