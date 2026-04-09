import { execInWorkspace } from "@/lib/workspace/exec";
import { PROJECT_DIR, TEST_TIMEOUT_MS, SERVER_TIMEOUT_MS, CURL_RETRY_CMD, SCREENSHOT_CMD } from "@/lib/constants";
import type { VerificationOutcome } from "@/lib/verification/report";
import type { BlueprintStep } from "../types";

/**
 * Create the verify-execute step.
 *
 * Dispatches on ctx.verificationStrategy to run the appropriate
 * verification method. Stores outcome and logs on ctx for the
 * report step to consume.
 */
export function createVerifyExecuteStep(): BlueprintStep {
  return {
    name: "verify-execute",
    async execute(ctx) {
      const start = Date.now();
      const strategy = ctx.verificationStrategy ?? "none";

      let outcome: VerificationOutcome;
      let logs = "";
      let msg: string;

      switch (strategy) {
        case "test-suite": {
          const result = await execInWorkspace(
            ctx.workspaceName,
            `cd ${PROJECT_DIR} && npm install && npm test`,
            { timeoutMs: TEST_TIMEOUT_MS },
          );
          logs = result.stdout + "\n" + result.stderr;
          outcome = result.exitCode === 0 ? "pass" : "fail";
          msg = `test-suite: npm test ${outcome === "pass" ? "passed" : "failed"} (exit ${result.exitCode})`;
          break;
        }

        case "web-app": {
          // Start dev server in background, then curl-retry
          await execInWorkspace(
            ctx.workspaceName,
            `cd ${PROJECT_DIR} && npm install && npm run dev &`,
          );

          const curlResult = await execInWorkspace(
            ctx.workspaceName,
            CURL_RETRY_CMD,
            { timeoutMs: SERVER_TIMEOUT_MS },
          );

          if (curlResult.exitCode === 0) {
            // Server responded — take screenshot
            const ssResult = await execInWorkspace(ctx.workspaceName, SCREENSHOT_CMD);
            logs = curlResult.stdout + "\n" + curlResult.stderr + "\n" + ssResult.stdout + "\n" + ssResult.stderr;
            outcome = "pass";
            msg = "web-app: dev server responded, screenshot captured";
          } else {
            logs = curlResult.stdout + "\n" + curlResult.stderr;
            outcome = "inconclusive";
            msg = "web-app: dev server did not respond within 60s";
          }
          break;
        }

        case "static-site": {
          // Serve static files, then curl-retry
          await execInWorkspace(
            ctx.workspaceName,
            `cd ${PROJECT_DIR} && npx -y serve . -l 3000 &`,
          );

          const curlResult = await execInWorkspace(
            ctx.workspaceName,
            CURL_RETRY_CMD,
            { timeoutMs: SERVER_TIMEOUT_MS },
          );

          if (curlResult.exitCode === 0) {
            const ssResult = await execInWorkspace(ctx.workspaceName, SCREENSHOT_CMD);
            logs = curlResult.stdout + "\n" + curlResult.stderr + "\n" + ssResult.stdout + "\n" + ssResult.stderr;
            outcome = "pass";
            msg = "static-site: serve responded, screenshot captured";
          } else {
            logs = curlResult.stdout + "\n" + curlResult.stderr;
            outcome = "inconclusive";
            msg = "static-site: serve did not respond within 60s";
          }
          break;
        }

        case "none":
        default: {
          outcome = "inconclusive";
          logs = "";
          msg = "No verification strategy found";
          break;
        }
      }

      const durationMs = Date.now() - start;

      // Store intermediate data for the report step (including execution duration)
      ctx.verificationReport = JSON.stringify({ outcome, logs, durationMs });

      console.log(`[blueprint] verify-execute: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs };
    },
  };
}
