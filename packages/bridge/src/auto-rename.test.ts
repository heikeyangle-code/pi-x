import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildAutoRenameTranscript,
  buildAutoRenamePrompt,
  sanitizeAutoRenameName,
  generateAutoRenameName,
} from "./auto-rename.js";
import { runPiPrintAssist } from "./engine-assist.js";

vi.mock("./engine-assist.js", () => ({
  runPiPrintAssist: vi.fn(),
}));

const runPiPrintAssistMock = vi.mocked(runPiPrintAssist);

beforeEach(() => {
  runPiPrintAssistMock.mockReset();
});

describe("buildAutoRenameTranscript", () => {
  it("extracts the first user_input text", () => {
    const transcript = buildAutoRenameTranscript([
      { type: "assistant", text: "hi" },
      { type: "user_input", text: "  Refactor the auth flow  " },
      { type: "user_input", text: "second" },
    ]);
    expect(transcript).toEqual({ userText: "Refactor the auth flow" });
  });

  it("returns null when there is no user text", () => {
    expect(buildAutoRenameTranscript([])).toBeNull();
    expect(
      buildAutoRenameTranscript([{ type: "assistant", text: "x" }]),
    ).toBeNull();
  });

  it("truncates long user text", () => {
    const long = "a".repeat(5000);
    const transcript = buildAutoRenameTranscript([
      { type: "user_input", text: long },
    ]);
    expect(transcript!.userText.length).toBeLessThan(2500);
    expect(transcript!.userText.endsWith("...")).toBe(true);
  });
});

describe("buildAutoRenamePrompt", () => {
  it("embeds the user text", () => {
    const prompt = buildAutoRenamePrompt({ userText: "fix login bug" });
    expect(prompt).toContain("fix login bug");
    expect(prompt.startsWith("Write a concise name")).toBe(true);
  });
});

describe("sanitizeAutoRenameName", () => {
  it("takes the first non-empty line and strips wrapping", () => {
    expect(sanitizeAutoRenameName('"Auth refactor"')).toBe("Auth refactor");
    expect(sanitizeAutoRenameName("`login flow`")).toBe("login flow");
    expect(sanitizeAutoRenameName("「ログイン修正」")).toBe("ログイン修正");
    expect(sanitizeAutoRenameName("```text Fix API tests```")).toBe(
      "Fix API tests",
    );
  });

  it("strips markdown bullets, prefixes and trailing punctuation", () => {
    expect(sanitizeAutoRenameName("- Draft PR summary")).toBe(
      "Draft PR summary",
    );
    expect(sanitizeAutoRenameName("name: quota chart")).toBeNull();
    expect(sanitizeAutoRenameName("配额图。")).toBe("配额图");
    expect(sanitizeAutoRenameName("[TODO]")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(sanitizeAutoRenameName("\n  \n")).toBeNull();
  });

  it("caps the name length", () => {
    const long = "x".repeat(120);
    expect(sanitizeAutoRenameName(long)!.length).toBe(60);
  });
});

describe("generateAutoRenameName", () => {
  it("runs a headless pi invocation and sanitizes the output", () => {
    runPiPrintAssistMock.mockReturnValue('"OAuth refresh"\n');
    const name = generateAutoRenameName({
      projectPath: "/tmp/proj",
      transcript: { userText: "refresh oauth tokens" },
    });
    expect(name).toBe("OAuth refresh");
    expect(runPiPrintAssistMock).toHaveBeenCalledWith({
      cwd: "/tmp/proj",
      prompt: expect.stringContaining("refresh oauth tokens"),
      model: undefined,
    });
  });

  it("returns null when pi output is unusable", () => {
    runPiPrintAssistMock.mockReturnValue("\n\n");
    expect(
      generateAutoRenameName({
        projectPath: "/tmp/proj",
        transcript: { userText: "x" },
      }),
    ).toBeNull();
  });
});
