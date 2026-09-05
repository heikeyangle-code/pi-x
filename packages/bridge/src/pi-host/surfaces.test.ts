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
