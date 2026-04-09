import { execInWorkspace } from "@/lib/workspace/exec";
import { PROJECT_DIR, GIT_TIMEOUT_MS, COMMIT_MSG_FILE } from "@/lib/constants";
import type { BlueprintStep } from "../types";

/**
 * Create the commit-and-push step.
 *
 * Git identity (user.name, user.email) is configured by Coder's
 * git-config module from the connected GitHub account — no hardcoding.
 * This step stages all changes, commits with a descriptive message
 * derived from the task prompt, and pushes to the task branch.
 */
export function createCommitPushStep(): BlueprintStep {
  return {
    name: "commit-push",
    async execute(ctx) {
      const start = Date.now();

      // 1. Stage all changes
      const addResult = await execInWorkspace(
        ctx.workspaceName,
        `cd ${PROJECT_DIR} && git add -A`,
        { timeoutMs: GIT_TIMEOUT_MS },
      );

      if (addResult.exitCode !== 0) {
        const msg = `Failed to stage changes: ${addResult.stderr.slice(0, 200)}`;
        console.log(`[blueprint] commit-push: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      // 3. Commit with descriptive message
      // Use base64 + git commit -F to avoid shell injection from user prompts.
      const subject = ctx.prompt.length > 72
        ? ctx.prompt.slice(0, 69) + "..."
        : ctx.prompt;
      const commitMsg = `hive: ${subject}`;
      const commitMsgB64 = Buffer.from(commitMsg, "utf-8").toString("base64");

      const commitResult = await execInWorkspace(
        ctx.workspaceName,
        `cd ${PROJECT_DIR} && echo '${commitMsgB64}' | base64 -d > ${COMMIT_MSG_FILE} && git commit -F ${COMMIT_MSG_FILE}`,
        { timeoutMs: GIT_TIMEOUT_MS },
      );

      if (commitResult.exitCode !== 0) {
        const msg = `Failed to commit: ${commitResult.stderr.slice(0, 200)}${commitResult.stdout.slice(0, 200)}`;
        console.log(`[blueprint] commit-push: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      // Extract commit hash from output (git commit outputs "[branch hash] message")
      const hashMatch = commitResult.stdout.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
      const commitHash = hashMatch ? hashMatch[1] : "unknown";

      // 4. Push to remote
      const pushResult = await execInWorkspace(
        ctx.workspaceName,
        `cd ${PROJECT_DIR} && git push -u origin ${ctx.branchName}`,
        { timeoutMs: GIT_TIMEOUT_MS },
      );

      if (pushResult.exitCode !== 0) {
        const msg = `Push failed: ${pushResult.stderr.slice(0, 300)}`;
        console.log(`[blueprint] commit-push: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      const msg = `Committed ${commitHash} and pushed to ${ctx.branchName}`;
      console.log(`[blueprint] commit-push: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs: Date.now() - start };
    },
  };
}
