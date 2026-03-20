import { execInWorkspace } from "@/lib/workspace/exec";
import type { VerificationStrategy } from "@/lib/verification/report";
import type { BlueprintStep } from "../types";

const PROJECT_DIR = "/home/coder/project";

/** The default npm test script that means "no real tests". */
const DEFAULT_TEST_SCRIPT = 'echo "Error: no test specified" && exit 1';

/**
 * Create the verify-detect step.
 *
 * Reads the project's package.json (if any) and applies the R007
 * detection heuristic to pick a verification strategy:
 *   1. Has a real test script → "test-suite"
 *   2. Has dev or start script → "web-app"
 *   3. Has index.html (no package.json) → "static-site"
 *   4. Fallback → "none"
 */
export function createVerifyDetectStep(): BlueprintStep {
  return {
    name: "verify-detect",
    async execute(ctx) {
      const start = Date.now();

      let strategy: VerificationStrategy = "none";

      // Try to read package.json
      const pkgResult = await execInWorkspace(
        ctx.workspaceName,
        `cat ${PROJECT_DIR}/package.json`,
      );

      if (pkgResult.exitCode === 0) {
        try {
          const pkg = JSON.parse(pkgResult.stdout);
          const scripts = pkg.scripts ?? {};

          if (scripts.test && scripts.test !== DEFAULT_TEST_SCRIPT) {
            strategy = "test-suite";
          } else if (scripts.dev || scripts.start) {
            strategy = "web-app";
          }
        } catch {
          // Malformed JSON — fall through to static-site check
        }
      }

      // If no strategy from package.json, check for static HTML
      if (strategy === "none") {
        const htmlResult = await execInWorkspace(
          ctx.workspaceName,
          `test -f ${PROJECT_DIR}/index.html`,
        );
        if (htmlResult.exitCode === 0) {
          strategy = "static-site";
        }
      }

      ctx.verificationStrategy = strategy;

      const msg = `Detected strategy: ${strategy}`;
      console.log(`[blueprint] verify-detect: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs: Date.now() - start };
    },
  };
}
