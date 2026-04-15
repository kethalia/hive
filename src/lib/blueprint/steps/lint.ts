import { execInWorkspace } from "@/lib/workspace/exec";
import { PROJECT_DIR, LINT_TIMEOUT_MS } from "@/lib/constants";
import type { BlueprintStep } from "../types";

/**
 * Create the lint-with-autofix step (R028).
 *
 * Best-effort: always returns success. Checks for a lint script in
 * package.json, runs it with --fix if present, and swallows failures.
 */
export function createLintStep(): BlueprintStep {
  return {
    name: "lint",
    async execute(ctx) {
      const start = Date.now();

      // 1. Check if package.json has a lint script
      const pkgResult = await execInWorkspace(
        ctx.workspaceName,
        `cd ${PROJECT_DIR} && cat package.json`,
        { timeoutMs: LINT_TIMEOUT_MS },
      );

      if (pkgResult.exitCode !== 0) {
        const msg = "Could not read package.json, skipping lint";
        console.log(`[blueprint] lint: ${msg} (task=${ctx.taskId})`);
        return { status: "success", message: msg, durationMs: Date.now() - start };
      }

      let hasLintScript = false;
      try {
        const pkg = JSON.parse(pkgResult.stdout);
        hasLintScript = Boolean(pkg?.scripts?.lint);
      } catch {
        const msg = "Could not parse package.json, skipping lint";
        console.log(`[blueprint] lint: ${msg} (task=${ctx.taskId})`);
        return { status: "success", message: msg, durationMs: Date.now() - start };
      }

      if (!hasLintScript) {
        const msg = "No lint script found, skipping";
        console.log(`[blueprint] lint: ${msg} (task=${ctx.taskId})`);
        return { status: "success", message: msg, durationMs: Date.now() - start };
      }

      // 2. Run lint with autofix
      const lintResult = await execInWorkspace(
        ctx.workspaceName,
        `cd ${PROJECT_DIR} && npm run lint -- --fix 2>&1`,
        { timeoutMs: LINT_TIMEOUT_MS, loginShell: true },
      );

      if (lintResult.exitCode === 124) {
        const msg = "Lint timed out, continuing";
        console.log(`[blueprint] lint: ${msg} (task=${ctx.taskId})`);
        return { status: "success", message: msg, durationMs: Date.now() - start };
      }

      if (lintResult.exitCode !== 0) {
        const msg = `Lint exited with code ${lintResult.exitCode}, continuing (best-effort)`;
        console.log(`[blueprint] lint: ${msg} (task=${ctx.taskId})`);
        return { status: "success", message: msg, durationMs: Date.now() - start };
      }

      const msg = "Lint autofix completed successfully";
      console.log(`[blueprint] lint: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs: Date.now() - start };
    },
  };
}
