import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listExtensionInfos,
  listPromptTemplates,
  parseTemplateMarkdown,
  sanitizeTemplateName,
  templateNameFromFile,
  writePromptTemplate,
  deletePromptTemplate,
  listThemes,
  writeCustomTheme,
  deleteCustomTheme,
  sanitizeContextFileName,
  findNearestContextFile,
  findContextFiles,
} from "./surfaces.js";

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pix-surfaces-"));
  return dir;
}

describe("templateNameFromFile / sanitizeTemplateName", () => {
  it("strips the .md extension", () => {
    expect(templateNameFromFile("pr.md")).toBe("pr");
    expect(templateNameFromFile("fix-tests.md")).toBe("fix-tests");
  });

  it("appends .md when missing", () => {
    expect(sanitizeTemplateName("pr")).toBe("pr.md");
    expect(sanitizeTemplateName(" pr.md ")).toBe("pr.md");
  });

  it("rejects traversal and blanks", () => {
    expect(sanitizeTemplateName("")).toBeNull();
    expect(sanitizeTemplateName("../x")).toBeNull();
    expect(sanitizeTemplateName("a/b")).toBeNull();
    expect(sanitizeTemplateName("..")).toBeNull();
    expect(sanitizeTemplateName("a..b")).toBeNull();
  });
});

describe("parseTemplateMarkdown", () => {
  it("reads description and argument-hint from frontmatter", () => {
    const info = parseTemplateMarkdown(
      '---\ndescription: "Fix failing tests"\nargument-hint: <test-pattern>\n---\n\nDo the thing.',
      "fix-tests.md",
      "project",
      "/p/.pi/prompts/fix-tests.md",
    );
    expect(info).toEqual({
      name: "fix-tests",
      scope: "project",
      description: "Fix failing tests",
      argumentHint: "<test-pattern>",
      path: "/p/.pi/prompts/fix-tests.md",
    });
  });

  it("falls back to the first non-empty body line, truncated to 60", () => {
    const long = "x".repeat(80);
    const info = parseTemplateMarkdown(
      `# ${long}\n\nbody`,
      "pr.md",
      "global",
      "/u/.pi/agent/prompts/pr.md",
    );
    // official semantics: the whole first line (incl. markdown prefix), cut at 60
    expect(info?.description).toBe(`# ${"x".repeat(58)}...`);
  });

  it("ignores files without a name", () => {
    expect(parseTemplateMarkdown("# hi", ".md", "global", "/x/.md")).toBeNull();
  });
});

describe("listExtensionInfos", () => {
  it("lists project and global extensions with scope", async () => {
    const root = makeHome();
    try {
      mkdirSync(join(root, "proj", ".pi", "extensions", "my-ext"), { recursive: true });
      mkdirSync(join(root, "home", ".pi", "agent", "extensions", "session.ts"), {
        recursive: true,
      });
      writeFileSync(join(root, "home", ".pi", "agent", "extensions", "session.ts", "index.ts"), "");
      const infos = await listExtensionInfos([
        { scope: "project", dir: join(root, "proj", ".pi", "extensions") },
        { scope: "global", dir: join(root, "home", ".pi", "agent", "extensions") },
      ]);
      expect(infos).toEqual([
        { name: "my-ext", scope: "project" },
        { name: "session.ts", scope: "global" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("listPromptTemplates", () => {
  it("scans global and project template dirs, non-recursive", async () => {
    const root = makeHome();
    try {
      const globalDir = join(root, "home", ".pi", "agent", "prompts");
      const projectDir = join(root, "proj", ".pi", "prompts");
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(globalDir, "pr.md"),
        '---\ndescription: "Open a PR"\n---\nBody',
      );
      writeFileSync(join(projectDir, "fix-tests.md"), "# Fix failing tests\n\nBody");
      writeFileSync(join(projectDir, "notes.txt"), "not a template");
      const infos = await listPromptTemplates(join(root, "proj"), join(root, "home"));
      expect(infos).toEqual([
        { name: "pr", scope: "global", description: "Open a PR", path: join(globalDir, "pr.md") },
        {
          name: "fix-tests",
          scope: "project",
          description: "# Fix failing tests",
          argumentHint: undefined,
          path: join(projectDir, "fix-tests.md"),
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writePromptTemplate / deletePromptTemplate", () => {
  it("writes into the scope dir and deletes it again", async () => {
    const root = makeHome();
    try {
      const file = await writePromptTemplate(
        join(root, "proj"),
        join(root, "home"),
        "project",
        "new-tpl",
        "---\ndescription: hi\n---\nBody",
      );
      expect(file).toBe(join(root, "proj", ".pi", "prompts", "new-tpl.md"));
      expect(readFileSync(file, "utf8")).toContain("description: hi");

      const deleted = await deletePromptTemplate(
        join(root, "proj"),
        join(root, "home"),
        "project",
        "new-tpl",
      );
      expect(deleted).toBe(true);
      expect(existsSync(file)).toBe(false);

      // deleting a missing file returns false, not an error
      expect(
        await deletePromptTemplate(join(root, "proj"), join(root, "home"), "project", "nope"),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal names", async () => {
    await expect(
      writePromptTemplate("/p", "/h", "global", "../evil", "x"),
    ).rejects.toThrow("invalid_template_name");
  });
});

describe("listThemes (pi theme.ts getAvailableThemesWithPaths)", () => {
  it("lists built-in dark/light plus custom themes with selection", async () => {
    const root = makeHome();
    try {
      const piHome = join(root, "home");
      const themesDir = join(piHome, ".pi", "agent", "themes");
      mkdirSync(themesDir, { recursive: true });
      writeFileSync(
        join(themesDir, "ocean.json"),
        JSON.stringify({ name: "ocean", colors: { text: "#fff" } }),
      );
      writeFileSync(join(themesDir, "broken.json"), "{ not json");
      const themes = await listThemes(piHome, "ocean");
      expect(themes).toEqual([
        { name: "dark", builtin: true, selected: false },
        { name: "light", builtin: true, selected: false },
        { name: "ocean", path: join(themesDir, "ocean.json"), builtin: false, selected: true },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks selection only on the matching name", async () => {
    const root = makeHome();
    try {
      const piHome = join(root, "home");
      const themes = await listThemes(piHome, "light");
      expect(themes.find((t) => t.name === "light")?.selected).toBe(true);
      expect(themes.find((t) => t.name === "dark")?.selected).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writeCustomTheme (pi ThemeJsonSchema)", () => {
  it("writes a valid theme to ~/.pi/agent/themes/<name>.json", async () => {
    const root = makeHome();
    try {
      const piHome = join(root, "home");
      const file = await writeCustomTheme(piHome, "sunset", {
        name: "sunset",
        colors: { accent: "#ff8800" },
      });
      expect(file).toBe(join(piHome, ".pi", "agent", "themes", "sunset.json"));
      const stored = JSON.parse(readFileSync(file, "utf8"));
      expect(stored.name).toBe("sunset");
      expect(stored.colors.accent).toBe("#ff8800");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing name / colors and non-object JSON", async () => {
    const root = makeHome();
    try {
      const piHome = join(root, "home");
      await expect(writeCustomTheme(piHome, "t", { colors: {} })).rejects.toThrow(
        /"name"/,
      );
      await expect(writeCustomTheme(piHome, "t", { name: "t" })).rejects.toThrow(
        /"colors"/,
      );
      await expect(writeCustomTheme(piHome, "t", [1, 2])).rejects.toThrow(
        /object/,
      );
      await expect(writeCustomTheme(piHome, "../evil", { name: "x", colors: {} })).rejects.toThrow(
        /Invalid theme name/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deleteCustomTheme removes only custom files", async () => {
    const root = makeHome();
    try {
      const piHome = join(root, "home");
      await writeCustomTheme(piHome, "ocean", { name: "ocean", colors: {} });
      expect(await deleteCustomTheme(piHome, "ocean")).toBe(true);
      expect(existsSync(join(piHome, ".pi", "agent", "themes", "ocean.json"))).toBe(false);
      expect(await deleteCustomTheme(piHome, "ocean")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("context files (AGENTS.md / CLAUDE.md quick edit)", () => {
  it("sanitizeContextFileName canonicalizes case-insensitively", () => {
    expect(sanitizeContextFileName("AGENTS.md")).toBe("AGENTS.md");
    expect(sanitizeContextFileName("agents.md")).toBe("AGENTS.md");
    expect(sanitizeContextFileName("CLAUDE.md")).toBe("CLAUDE.md");
    expect(sanitizeContextFileName("README.md")).toBeNull();
    expect(sanitizeContextFileName("")).toBeNull();
    expect(sanitizeContextFileName(null)).toBeNull();
  });

  it("findNearestContextFile walks up from cwd to the filesystem root", async () => {
    const root = makeHome();
    try {
      mkdirSync(join(root, "a", "b", "c"), { recursive: true });
      writeFileSync(join(root, "a", "AGENTS.md"), "top");
      expect(await findNearestContextFile(join(root, "a", "b", "c"), "AGENTS.md")).toBe(
        join(root, "a", "AGENTS.md"),
      );
      // deepest copy wins
      writeFileSync(join(root, "a", "b", "AGENTS.md"), "mid");
      expect(await findNearestContextFile(join(root, "a", "b", "c"), "AGENTS.md")).toBe(
        join(root, "a", "b", "AGENTS.md"),
      );
      expect(await findNearestContextFile(join(root, "a", "b", "c"), "CLAUDE.md")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("findContextFiles reports per-file path and project-local target", async () => {
    const root = makeHome();
    try {
      const cwd = join(root, "proj");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "CLAUDE.md"), "hi");
      const files = await findContextFiles(cwd);
      expect(files).toEqual([
        { name: "AGENTS.md", path: null, targetPath: join(cwd, "AGENTS.md") },
        { name: "CLAUDE.md", path: join(cwd, "CLAUDE.md"), targetPath: join(cwd, "CLAUDE.md") },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
