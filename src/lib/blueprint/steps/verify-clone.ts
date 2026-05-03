import { PROJECT_DIR } from "@/lib/constants";
import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintStep } from "../types";

/**
 * Create the verify-clone step.
 *
 * Clones the repository and checks out the PR branch inside the
 * verifier workspace so subsequent steps can inspect the code.
 *
 * Idempotent: if the project directory already exists (e.g. from
 * the template init.sh), fetches and resets to the target branch
 * instead of cloning again.
 *
 * Uses base64 encoding for repoUrl and branchName to prevent
 * shell injection (these originate from job input).
 */
export function createVerifyCloneStep(): BlueprintStep {
  return {
    name: "verify-clone",
    async execute(ctx) {
      const start = Date.now();

      // Base64-encode user-controlled values to prevent shell injection
      const repoUrlB64 = Buffer.from(ctx.repoUrl, "utf-8").toString("base64");
      const branchB64 = Buffer.from(ctx.branchName, "utf-8").toString("base64");

      const cloneCmd = [
        `REPO_URL="$(echo '${repoUrlB64}' | base64 -d)"`,
        `BRANCH="$(echo '${branchB64}' | base64 -d)"`,
        `if [ ! -d "${PROJECT_DIR}" ]; then`,
        `  gh repo clone "$REPO_URL" ${PROJECT_DIR} &&`,
        `  cd ${PROJECT_DIR} &&`,
        `  git checkout "$BRANCH"`,
        `else`,
        `  cd ${PROJECT_DIR} &&`,
        `  git fetch origin &&`,
        `  git checkout "$BRANCH" &&`,
        `  git reset --hard "origin/$BRANCH"`,
        `fi`,
      ].join("\n");

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
