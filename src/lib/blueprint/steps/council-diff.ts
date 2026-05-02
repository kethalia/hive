import { PROJECT_DIR } from "@/lib/constants";
import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintContext, BlueprintStep } from "../types";

/**
 * Create the council-diff step.
 *
 * Runs `git diff origin/main...HEAD` inside the council reviewer workspace
 * and stores the output on `ctx.councilDiff` for subsequent steps.
 *
 * An empty diff (no changes relative to main) is treated as a valid success
 * case — it sets `ctx.councilDiff = ""` and returns a descriptive message
 * rather than failing the job.
 */
export function createCouncilDiffStep(): BlueprintStep {
  return {
    name: "council-diff",
    async execute(ctx: BlueprintContext) {
      const start = Date.now();

      const diffCmd = `cd ${PROJECT_DIR} && git diff origin/main...HEAD`;
      const result = await execInWorkspace(ctx.workspaceName, diffCmd);

      if (result.exitCode !== 0) {
        const stderr = result.stderr.slice(0, 500);
        const msg = `Failed to get diff: ${stderr}`;
        console.log(`[blueprint] council-diff: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      ctx.councilDiff = result.stdout;

      if (!result.stdout) {
        const msg = "Empty diff — no changes to review";
        console.log(`[blueprint] council-diff: ${msg} (task=${ctx.taskId})`);
        return { status: "success", message: msg, durationMs: Date.now() - start };
      }

      const lines = result.stdout.split("\n").length;
      const msg = `Diff captured (${lines} lines)`;
      console.log(`[blueprint] council-diff: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs: Date.now() - start };
    },
  };
}
