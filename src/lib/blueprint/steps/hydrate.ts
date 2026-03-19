import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintStep } from "../types";

const PROJECT_DIR = "/home/coder/project";
const EXEC_TIMEOUT_MS = 30_000;

/** Key files to read for context (order matters for prompt assembly). */
const KEY_FILES = [
  "README.md",
  "package.json",
  "tsconfig.json",
  "AGENTS.md",
  ".github/CODEOWNERS",
];

/**
 * Create the context hydration step (R027).
 *
 * Fetches the repository file tree and key files from the workspace,
 * assembles them into a structured context string on `ctx.assembledContext`.
 */
export function createHydrateStep(): BlueprintStep {
  return {
    name: "hydrate-context",
    async execute(ctx) {
      const start = Date.now();

      // 1. Get repo file tree
      const treeResult = await execInWorkspace(
        ctx.workspaceName,
        `find ${PROJECT_DIR} -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" \) | head -200`,
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      if (treeResult.exitCode !== 0 && treeResult.stdout.trim() === "") {
        return {
          status: "failure",
          message: `Failed to list repo files: ${treeResult.stderr.slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }

      const fileTree = treeResult.stdout.trim();
      const fileCount = fileTree ? fileTree.split("\n").length : 0;

      // 2. Read key files (missing files are silently skipped)
      const fileSections: string[] = [];
      for (const file of KEY_FILES) {
        const filePath = `${PROJECT_DIR}/${file}`;

        // Check existence first
        const testResult = await execInWorkspace(
          ctx.workspaceName,
          `test -f ${filePath} && echo exists`,
          { timeoutMs: EXEC_TIMEOUT_MS },
        );

        if (testResult.stdout.trim() !== "exists") {
          continue;
        }

        const catResult = await execInWorkspace(
          ctx.workspaceName,
          `cat ${filePath}`,
          { timeoutMs: EXEC_TIMEOUT_MS },
        );

        if (catResult.exitCode === 0) {
          fileSections.push(`### ${file}\n${catResult.stdout}`);
        }
      }

      // 3. Assemble structured context
      const parts = [`## Repository Structure\n${fileTree}`];
      if (fileSections.length > 0) {
        parts.push(`## Key Files\n${fileSections.join("\n\n")}`);
      }

      ctx.assembledContext = parts.join("\n\n");

      console.log(
        `[blueprint] hydrate-context: assembled ${fileCount} tree files, ${fileSections.length} key files (task=${ctx.taskId})`,
      );

      return {
        status: "success",
        message: `Hydrated context: ${fileCount} tree files, ${fileSections.length} key files`,
        durationMs: Date.now() - start,
      };
    },
  };
}
