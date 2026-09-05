import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/Users/testuser",
}));

const { setupLaunchd, uninstallLaunchd } = await import("./setup-launchd.js");

const PLIST_PATH = "/Users/testuser/Library/LaunchAgents/com.ccpocket.bridge.plist";
const originalBridgeEnv = {
  port: process.env.BRIDGE_PORT,
  allowedDirs: process.env.BRIDGE_ALLOWED_DIRS,
  publicWsUrl: process.env.BRIDGE_PUBLIC_WS_URL,
  disableMdns: process.env.BRIDGE_DISABLE_MDNS,
};

describe("setup-launchd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBridgeEnv();
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue("/usr/bin/npx\n");
  });

  afterEach(() => {
    restoreBridgeEnv();
  });

  describe("setupLaunchd", () => {
    it("writes correct plist with default options", () => {
      setupLaunchd({});

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const [path, content] = mockWriteFileSync.mock.calls[0] as [string, string];
      expect(path).toBe(PLIST_PATH);
      expect(content).toContain("<key>BRIDGE_PORT</key>");
      expect(content).toContain("<string>8765</string>");
      expect(content).toContain("<key>BRIDGE_HOST</key>");
      expect(content).toContain(
        "<string>exec npx --yes @ccpocket/bridge@1</string>",
      );
      expect(content).not.toContain("BRIDGE_API_KEY");
      expect(content).not.toContain("BRIDGE_ALLOWED_DIRS");
      expect(content).not.toContain("BRIDGE_PUBLIC_WS_URL");
      expect(content).not.toContain("BRIDGE_DISABLE_MDNS");
    });

    it.each(["", "123abc"])(
      "rejects invalid port %j before writing or registering a service",
      (port) => {
        expect(() => setupLaunchd({ port })).toThrow(
          `Invalid BRIDGE_PORT "${port}"`,
        );

        expect(mockWriteFileSync).not.toHaveBeenCalled();
        expect(mockExecSync).not.toHaveBeenCalled();
      },
    );

    it("includes BRIDGE_ALLOWED_DIRS when provided", () => {
      process.env.BRIDGE_ALLOWED_DIRS = "/Users/testuser,/tmp/work";

      setupLaunchd({});

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_ALLOWED_DIRS</key>");
      expect(content).toContain("<string>/Users/testuser,/tmp/work</string>");
    });

    it("includes BRIDGE_DISABLE_MDNS when requested", () => {
      setupLaunchd({ disableMdns: true });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_DISABLE_MDNS</key>");
      expect(content).toContain("<string>1</string>");
    });

    it("includes BRIDGE_PUBLIC_WS_URL when publicWsUrl is provided", () => {
      setupLaunchd({ publicWsUrl: "wss://example.com/ws" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<key>BRIDGE_PUBLIC_WS_URL</key>");
      expect(content).toContain("<string>wss://example.com/ws</string>");
    });

    it("prefers explicit publicWsUrl over environment", () => {
      process.env.BRIDGE_PUBLIC_WS_URL = "wss://env.example.com";

      setupLaunchd({ publicWsUrl: "wss://flag.example.com" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("<string>wss://flag.example.com</string>");
      expect(content).not.toContain("wss://env.example.com");
    });
  });

  describe("uninstallLaunchd", () => {
    it("deletes plist when it exists", () => {
      mockExistsSync.mockReturnValue(true);

      uninstallLaunchd();

      expect(mockUnlinkSync).toHaveBeenCalledWith(PLIST_PATH);
    });
  });
});

function clearBridgeEnv(): void {
  delete process.env.BRIDGE_PORT;
  delete process.env.BRIDGE_ALLOWED_DIRS;
  delete process.env.BRIDGE_PUBLIC_WS_URL;
  delete process.env.BRIDGE_DISABLE_MDNS;
}

function restoreBridgeEnv(): void {
  restoreEnvVar("BRIDGE_PORT", originalBridgeEnv.port);
  restoreEnvVar("BRIDGE_ALLOWED_DIRS", originalBridgeEnv.allowedDirs);
  restoreEnvVar("BRIDGE_PUBLIC_WS_URL", originalBridgeEnv.publicWsUrl);
  restoreEnvVar("BRIDGE_DISABLE_MDNS", originalBridgeEnv.disableMdns);
}

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
