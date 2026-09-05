import { runPiPrintAssist } from "./engine-assist.js";
import { getStagedDiff } from "./git-operations.js";

const COMMIT_MESSAGE_PROMPT =
  "Write a single Conventional Commits message in English for the staged changes below. Output only the commit message, with no quotes or explanation.";
export interface GitAssistOptions {
  projectPath: string;
  model?: string;
}

/** Generate a Conventional Commits message via a headless pi invocation. */
export function generateCommitMessage(options: GitAssistOptions): string {
  const diff = getStagedDiff(options.projectPath).trim();
  if (!diff) {
    throw new Error("Nothing to commit: no files are staged");
  }
  const output = runPiPrintAssist({
    cwd: options.projectPath,
    prompt: `${COMMIT_MESSAGE_PROMPT}\n\n${diff}`,
    model: options.model,
  });
  const message = output
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!message) {
    throw new Error("Commit message generation returned empty output");
  }
  return message;
}
