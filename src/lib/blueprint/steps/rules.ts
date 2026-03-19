import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintStep } from "../types";

const PROJECT_DIR = "/home/coder/project";
const EXEC_TIMEOUT_MS = 30_000;

/**
 * Create the scoped rules injection step (R026).
 *
 * Finds all AGENTS.md files in the workspace repo (up to depth 3),
 * concatenates their contents with source path headers, and stores
 * the result on `ctx.scopedRules`.
 */
export function createRulesStep(): BlueprintStep {
  return {
    name: "scoped-rules",
    async execute(ctx) {
      const start = Date.now();

      // Find AGENTS.md files at up to 3 levels deep
      const findResult = await execInWorkspace(
        ctx.workspaceName,
        `find ${PROJECT_DIR} -maxdepth 3 -name "AGENTS.md"`,
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      const paths = findResult.stdout
        .trim()
        .split("\n")
        .filter((p) => p.length > 0);

      if (findResult.exitCode !== 0 && paths.length === 0) {
        return {
          status: "failure",
          message: `Failed to search for AGENTS.md: ${findResult.stderr.slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }

      if (paths.length === 0) {
        console.log(
          `[blueprint] scoped-rules: no AGENTS.md files found (task=${ctx.taskId})`,
        );
        return {
          status: "skipped",
          message: "No AGENTS.md files found in repo",
          durationMs: Date.now() - start,
        };
      }

      // Read each AGENTS.md and concatenate with path headers
      const sections: string[] = [];
      for (const filePath of paths) {
        const catResult = await execInWorkspace(
          ctx.workspaceName,
          `cat ${filePath}`,
          { timeoutMs: EXEC_TIMEOUT_MS },
        );

        if (catResult.exitCode === 0) {
          sections.push(
            `## Rules from ${filePath}\n${catResult.stdout}`,
          );
        }
      }

      ctx.scopedRules = sections.join("\n\n");

      console.log(
        `[blueprint] scoped-rules: loaded ${sections.length} rule file(s) (task=${ctx.taskId})`,
      );

      return {
        status: "success",
        message: `Loaded ${sections.length} AGENTS.md file(s)`,
        durationMs: Date.now() - start,
      };
    },
  };
}
