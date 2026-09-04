import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixConfigFile } from "./pix-config.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "pix-config-")), "pix-config.json");
}

describe("PixConfigFile", () => {
  it("loads an empty config when the file is missing", async () => {
    const cfg = new PixConfigFile(tmpFile());
    expect(await cfg.load()).toEqual({});
  });

  it("loads an empty config for corrupt JSON", async () => {
    const { writeFileSync } = await import("node:fs");
    const file = tmpFile();
    writeFileSync(file, "{not json", "utf8");
    const cfg = new PixConfigFile(file);
    expect(await cfg.load()).toEqual({});
  });

  it("round-trips engineArgs through update + load", async () => {
    const cfg = new PixConfigFile(tmpFile());
    const next = await cfg.update({ engineArgs: ["--no-context-files", "--no-skills"] });
    expect(next.engineArgs).toEqual(["--no-context-files", "--no-skills"]);
    expect((await cfg.load()).engineArgs).toEqual(["--no-context-files", "--no-skills"]);
  });

  it("filters empty strings and keeps unrelated fields untouched", async () => {
    const cfg = new PixConfigFile(tmpFile());
    await cfg.update({ engineArgs: ["--tools", "bash", ""] });
    const read = await cfg.load();
    expect(read.engineArgs).toEqual(["--tools", "bash"]);
    // merge semantics: updating again does not drop the previous engineArgs
    await cfg.update({});
    expect((await cfg.load()).engineArgs).toEqual(["--tools", "bash"]);
  });
});
