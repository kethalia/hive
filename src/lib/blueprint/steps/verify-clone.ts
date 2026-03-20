import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintStep } from "../types";

const PROJECT_DIR = "/home/coder/project";

/**
 * Create the verify-clone step.
 *
 * Clones the repository and checks out the PR branch inside the
 * verifier workspace so subsequent steps can inspect the code.
 */
export function createVerifyCloneStep(): BlueprintStep {
  return {
    name: "verify-clone",
    async execute(ctx) {
      const start = Date.now();

      const cloneCmd = `gh repo clone ${ctx.repoUrl} ${PROJECT_DIR} && cd ${PROJECT_DIR} && git checkout ${ctx.branchName}`;

      const result = await execInWorkspace(ctx.workspaceName, cloneCmd);

      if (result.exitCode !== 0) {
        const stderr = result.stderr.slice(0, 500);
        const msg = `Clone/checkout failed: ${stderr}`;
        console.log(`[blueprint] verify-clone: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      const msg = `Cloned and checked out ${ctx.branchName}`;
      console.log(`[blueprint] verify-clone: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs: Date.now() - start };
    },
  };
}
