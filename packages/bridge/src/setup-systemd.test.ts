import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing the module
const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock node:fs
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

// Mock node:os
vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

// Import after mocks
const { setupSystemd, uninstallSystemd } = await import("./setup-systemd.js");

const SERVICE_PATH =
  "/home/testuser/.config/systemd/user/ccpocket-bridge.service";
const originalBridgeEnv = {
  port: process.env.BRIDGE_PORT,
  allowedDirs: process.env.BRIDGE_ALLOWED_DIRS,
  publicWsUrl: process.env.BRIDGE_PUBLIC_WS_URL,
  disableMdns: process.env.BRIDGE_DISABLE_MDNS,
};

describe("setup-systemd", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "linux" });
    clearBridgeEnv();
    // Default: directory exists, npx found
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue("/usr/bin/npx\n");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    restoreBridgeEnv();
  });

  describe("setupSystemd", () => {
    it("writes correct service file with default options", () => {
      setupSystemd({});

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const [path, content] = mockWriteFileSync.mock.calls[0] as [
        string,
        string,
      ];
      expect(path).toBe(SERVICE_PATH);
      expect(content).toContain("[Unit]");
      expect(content).toContain("Description=CC Pocket Bridge Server");
      expect(content).toContain(
        'ExecStart=/bin/bash -lc \'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true; fi; export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; exec npx --yes @ccpocket/bridge@1\'',
      );
      expect(content).toContain(
        "Environment=PATH=/home/testuser/.local/bin:/home/testuser/bin:/home/testuser/.nvm/versions/node/current/bin:/home/testuser/.volta/bin:/home/testuser/.mise/shims:/home/testuser/.asdf/shims:/home/testuser/.bun/bin:/home/testuser/.npm-global/bin:/usr/local/bin:/usr/bin:/bin",
      );
      expect(content).toContain("Environment=BRIDGE_PORT=8765");
      expect(content).toContain("Environment=BRIDGE_HOST=0.0.0.0");
      expect(content).toContain("Restart=on-failure");
      expect(content).toContain("WantedBy=default.target");
      expect(content).not.toContain("BRIDGE_API_KEY");
      expect(content).not.toContain("BRIDGE_ALLOWED_DIRS");
      expect(content).not.toContain("BRIDGE_DISABLE_MDNS");
    });

    it("rejects an invalid environment port before writing or registering a service", () => {
      process.env.BRIDGE_PORT = "65536";

      expect(() => setupSystemd({})).toThrow('Invalid BRIDGE_PORT "65536"');
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("includes BRIDGE_API_KEY when apiKey is provided", () => {
      setupSystemd({ apiKey: "my-secret" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("Environment=BRIDGE_API_KEY=my-secret");
    });

    it("includes BRIDGE_ALLOWED_DIRS when provided", () => {
      process.env.BRIDGE_ALLOWED_DIRS = "/home/testuser,/scratch/testuser";

      setupSystemd({});

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain(
        "Environment=BRIDGE_ALLOWED_DIRS=/home/testuser,/scratch/testuser",
      );
    });

    it("includes BRIDGE_DISABLE_MDNS when requested", () => {
      setupSystemd({ disableMdns: true });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("Environment=BRIDGE_DISABLE_MDNS=1");
    });

    it("keeps standalone Node paths before npm-managed Node paths", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v npx") {
          return "/home/testuser/.nvm/versions/node/v22.18.0/bin/npx\n";
        }
        return "";
      });

      setupSystemd({});

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain(
        "Environment=PATH=/home/testuser/.local/bin:/home/testuser/bin:/home/testuser/.nvm/versions/node/current/bin:/home/testuser/.volta/bin:/home/testuser/.mise/shims:/home/testuser/.asdf/shims:/home/testuser/.bun/bin:/home/testuser/.npm-global/bin:/home/testuser/.nvm/versions/node/v22.18.0/bin:/usr/local/bin:/usr/bin:/bin",
      );
    });

    it("includes BRIDGE_PUBLIC_WS_URL when publicWsUrl is provided", () => {
      setupSystemd({ publicWsUrl: "wss://example.com/ws" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain(
        "Environment=BRIDGE_PUBLIC_WS_URL=wss://example.com/ws",
      );
    });

    it("prefers explicit publicWsUrl over environment", () => {
      process.env.BRIDGE_PUBLIC_WS_URL = "wss://env.example.com";

      setupSystemd({ publicWsUrl: "wss://flag.example.com" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain(
        "Environment=BRIDGE_PUBLIC_WS_URL=wss://flag.example.com",
      );
      expect(content).not.toContain("wss://env.example.com");
    });

    it("omits BRIDGE_API_KEY when apiKey is empty", () => {
      setupSystemd({ apiKey: "" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).not.toContain("BRIDGE_API_KEY");
    });

    it("uses custom port and host", () => {
      setupSystemd({ port: "9999", host: "127.0.0.1" });

      const content = mockWriteFileSync.mock.calls[0]![1] as string;
      expect(content).toContain("Environment=BRIDGE_PORT=9999");
      expect(content).toContain("Environment=BRIDGE_HOST=127.0.0.1");
    });

    it("creates directory when it does not exist", () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p.includes("systemd/user")) return false;
        return true;
      });

      setupSystemd({});

      expect(mockMkdirSync).toHaveBeenCalledWith(
        "/home/testuser/.config/systemd/user",
        { recursive: true },
      );
    });

    it("calls systemctl daemon-reload, enable, and restart in order", () => {
      setupSystemd({});

      const systemctlCalls = mockExecSync.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd: string) => cmd.includes("systemctl"));

      expect(systemctlCalls).toEqual([
        "systemctl --user daemon-reload",
        'systemctl --user enable "ccpocket-bridge"',
        'systemctl --user restart "ccpocket-bridge"',
      ]);
    });

    it("enables linger when not already enabled", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v npx") return "/usr/bin/npx\n";
        if (cmd.includes("show-user")) return "Linger=no\n";
        return "";
      });

      setupSystemd({});

      const allCmds = mockExecSync.mock.calls.map((c) => c[0] as string);
      expect(allCmds).toContain("loginctl enable-linger $USER");
    });

    it("skips linger when already enabled", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v npx") return "/usr/bin/npx\n";
        if (cmd.includes("show-user")) return "Linger=yes\n";
        return "";
      });

      setupSystemd({});

      const allCmds = mockExecSync.mock.calls.map((c) => c[0] as string);
      expect(allCmds).not.toContain("loginctl enable-linger $USER");
    });

    it("handles linger check failure gracefully", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v npx") return "/usr/bin/npx\n";
        if (cmd.includes("loginctl")) throw new Error("loginctl failed");
        return "";
      });

      expect(() => setupSystemd({})).not.toThrow();
    });

    it("exits with code 1 when npx is not found", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v npx") throw new Error("not found");
        return "";
      });

      const mockExit = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);

      setupSystemd({});

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });

  describe("uninstallSystemd", () => {
    it("calls stop, disable, deletes file, and daemon-reload", () => {
      mockExistsSync.mockReturnValue(true);

      uninstallSystemd();

      const allCmds = mockExecSync.mock.calls.map((c) => c[0] as string);
      expect(allCmds).toContain(
        'systemctl --user stop "ccpocket-bridge"',
      );
      expect(allCmds).toContain(
        'systemctl --user disable "ccpocket-bridge"',
      );
      expect(allCmds).toContain("systemctl --user daemon-reload");
      expect(mockUnlinkSync).toHaveBeenCalledWith(SERVICE_PATH);
    });

    it("does not delete file when it does not exist", () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith(".service")) return false;
        return true;
      });

      uninstallSystemd();

      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it("handles systemctl errors gracefully", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("systemctl failed");
      });
      mockExistsSync.mockReturnValue(false);

      expect(() => uninstallSystemd()).not.toThrow();
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
