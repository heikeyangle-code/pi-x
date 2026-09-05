import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CheckResult, ProviderResult, DoctorReport } from "./doctor.js";

// Mock child_process before importing the module
const mockExecSync = vi.fn();
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock node:fs
const mockExistsSync = vi.fn();
const mockAccessSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  accessSync: (...args: unknown[]) => mockAccessSync(...args),
  readFileSync: () => "{}",
  constants: { R_OK: 4, W_OK: 2 },
}));

// Import after mocks
const {
  checkNodeVersion,
  checkGit,
  checkPiEngine,
  checkDependencies,
  checkPortAvailable,
  checkDataDirectory,
  printReport,
  runDoctor,
} = await import("./doctor.js");

describe("doctor checks (pi-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkNodeVersion", () => {
    it("passes on current Node.js version (>=20.18.1)", async () => {
      const result = await checkNodeVersion();
      expect(result.status).toBe("pass");
      expect(result.message).toMatch(/^v\d+/);
    });
  });

  describe("checkGit", () => {
    it("passes when git is installed", async () => {
      mockExecSync.mockReturnValue("git version 2.44.0");
      const result = await checkGit();
      expect(result.status).toBe("pass");
      expect(result.message).toContain("2.44.0");
    });

    it("fails when git is not installed", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("command not found");
      });
      const result = await checkGit();
      expect(result.status).toBe("fail");
      expect(result.remediation).toBeDefined();
    });
  });

  describe("checkPiEngine", () => {
    afterEach(() => {
      delete process.env.PI_ENGINE_ENTRY;
      delete process.env.PI_HOME;
    });

    it("fails when PI_ENGINE_ENTRY is not configured", async () => {
      const result = await checkPiEngine();
      expect(result.status).toBe("fail");
      expect(result.remediation).toContain("PI_ENGINE_ENTRY");
      expect(result.providers[0].name).toBe("Pi engine");
      expect(result.providers[0].installed).toBe(false);
    });

    it("passes when the pi CLI runs and credentials exist", async () => {
      process.env.PI_ENGINE_ENTRY = "/engines/0.85.0/node_modules/.bin/pi";
      mockExecSync.mockReturnValue("0.85.0");
      mockExistsSync.mockReturnValue(true);
      const result = await checkPiEngine();
      expect(result.status).toBe("pass");
      expect(result.providers[0].version).toBe("0.85.0");
      expect(result.providers[0].authenticated).toBe(true);
    });

    it("warns when the pi CLI runs but no credentials are stored", async () => {
      process.env.PI_ENGINE_ENTRY = "/engines/0.85.0/node_modules/.bin/pi";
      mockExecSync.mockReturnValue("0.85.0");
      mockExistsSync.mockReturnValue(false);
      const result = await checkPiEngine();
      expect(result.status).toBe("warn");
      expect(result.providers[0].authenticated).toBe(false);
      expect(result.remediation).toContain("/login");
    });

    it("fails when the pi CLI is not runnable", async () => {
      process.env.PI_ENGINE_ENTRY = "/engines/0.85.0/node_modules/.bin/pi";
      mockExecSync.mockImplementation(() => {
        throw new Error("command not found");
      });
      const result = await checkPiEngine();
      expect(result.status).toBe("fail");
      expect(result.remediation).toContain("install the pi engine");
    });
  });

  describe("checkDependencies", () => {
    it("passes when required packages resolve", async () => {
      const result = await checkDependencies();
      expect(result.status).toBe("pass");
      expect(result.message).toContain("All packages available");
    });
  });

  describe("checkPortAvailable", () => {
    it("passes when port is available", async () => {
      const result = await checkPortAvailable(0); // port 0 = random available
      expect(result.status).toBe("pass");
    });
  });

  describe("checkDataDirectory", () => {
    it("passes when directory exists and is writable", async () => {
      mockExistsSync.mockReturnValue(true);
      mockAccessSync.mockReturnValue(undefined);
      const result = await checkDataDirectory();
      expect(result.status).toBe("pass");
      expect(result.message).toContain("exists");
    });

    it("passes when directory does not exist (will be created)", async () => {
      mockExistsSync.mockReturnValue(false);
      const result = await checkDataDirectory();
      expect(result.status).toBe("pass");
      expect(result.message).toContain("will be created");
    });

    it("warns when directory is not writable", async () => {
      mockExistsSync.mockReturnValue(true);
      mockAccessSync.mockImplementation(() => {
        throw new Error("EACCES");
      });
      const result = await checkDataDirectory();
      expect(result.status).toBe("warn");
    });
  });

  describe("runDoctor", () => {
    it("runs the pi-only check list without remote-era checks", async () => {
      process.env.PI_ENGINE_ENTRY = "/engines/0.85.0/node_modules/.bin/pi";
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("--version")) return "0.85.0";
        if (cmd.includes("git")) return "git version 2.44.0";
        return "";
      });
      mockExistsSync.mockReturnValue(true);
      mockAccessSync.mockReturnValue(undefined);
      const report = await runDoctor();
      const names = report.results.map((r) => r.name);
      expect(names).toContain("Pi engine");
      expect(names).toContain("Node.js");
      expect(names).toContain("Git");
      expect(names).not.toContain("Tailscale");
      expect(names).not.toContain("Firebase connectivity");
      expect(names).not.toContain("Keychain access");
      expect(names).not.toContain("launchd service");
      expect(report.allRequiredPassed).toBe(true);
    });
  });

  describe("printReport", () => {
    it("does not throw for a basic report", () => {
      const report: DoctorReport = {
        results: [
          { name: "Node.js", status: "pass", message: "v22.0.0", category: "required" },
          { name: "Git", status: "fail", message: "Not installed", remediation: "Install Git", category: "required" },
          { name: "Data directory", status: "skip", message: "Not installed", category: "optional" },
        ],
        allRequiredPassed: false,
      };
      expect(() => printReport(report)).not.toThrow();
    });

    it("handles a report with the pi engine provider", () => {
      const report: DoctorReport = {
        results: [
          {
            name: "Pi engine",
            status: "pass",
            message: "0.85.0",
            category: "required",
            providers: [
              { name: "Pi engine", installed: true, version: "0.85.0", authenticated: true },
            ],
          },
        ],
        allRequiredPassed: true,
      };
      expect(() => printReport(report)).not.toThrow();
    });

    it("prints a provider auth message instead of the generic authenticated label", () => {
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.map((arg) => String(arg)).join(" "));
        });
      try {
        printReport({
          results: [
            {
              name: "Pi engine",
              status: "warn",
              message: "0.85.0",
              category: "required",
              providers: [
                {
                  name: "Pi engine",
                  installed: true,
                  version: "0.85.0",
                  authenticated: false,
                  authMessage: "No credentials yet — log in via /login in the pi engine",
                },
              ],
            },
          ],
          allRequiredPassed: true,
        });
      } finally {
        spy.mockRestore();
      }

      const output = logs.join("\n");
      expect(output).toContain("No credentials yet");
      expect(output).not.toContain("(authenticated)");
    });
  });
});
