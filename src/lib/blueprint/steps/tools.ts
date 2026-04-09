import { execInWorkspace } from "@/lib/workspace/exec";
import { PROJECT_DIR, EXEC_TIMEOUT_MS, BASE_TOOLS, WEB_FRAMEWORKS, TEST_FRAMEWORKS } from "@/lib/constants";
import type { BlueprintStep } from "../types";

/**
 * Create the curated tool selection step (R030).
 *
 * Detects repo type from package.json and selects appropriate tool flags.
 * Non-Node repos get base tools only (not a failure).
 */
export function createToolsStep(): BlueprintStep {
  return {
    name: "tool-selection",
    async execute(ctx) {
      const start = Date.now();

      const catResult = await execInWorkspace(
        ctx.workspaceName,
        `cat ${PROJECT_DIR}/package.json`,
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      // Non-Node repo: return base tools
      if (catResult.exitCode !== 0) {
        ctx.toolFlags = [...BASE_TOOLS];
        console.log(
          `[blueprint] tool-selection: no package.json, using base tools (task=${ctx.taskId})`,
        );
        return {
          status: "success",
          message: "No package.json found — using base tools",
          durationMs: Date.now() - start,
        };
      }

      let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(catResult.stdout);
      } catch {
        ctx.toolFlags = [...BASE_TOOLS];
        return {
          status: "success",
          message: "Invalid package.json — using base tools",
          durationMs: Date.now() - start,
        };
      }

      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      const depNames = Object.keys(allDeps);

      const tools = [...BASE_TOOLS];
      const detectedTypes: string[] = [];

      // Check for web frameworks → browser tools
      const webMatch = WEB_FRAMEWORKS.find((fw) =>
        depNames.some((d) => d === fw || d === `@${fw}/core`),
      );
      if (webMatch) {
        tools.push("browser");
        detectedTypes.push(webMatch);
      }

      // Check for test frameworks → test tool
      const testMatch = TEST_FRAMEWORKS.find((fw) =>
        depNames.some((d) => d === fw || d === `@${fw}/test`),
      );
      if (testMatch) {
        tools.push("test");
        detectedTypes.push(`test:${testMatch}`);
      }

      ctx.toolFlags = tools;

      const typeDesc = detectedTypes.length > 0
        ? detectedTypes.join(", ")
        : "plain Node.js";

      console.log(
        `[blueprint] tool-selection: detected [${typeDesc}], tools=[${tools.join(",")}] (task=${ctx.taskId})`,
      );

      return {
        status: "success",
        message: `Detected ${typeDesc} — ${tools.length} tools selected`,
        durationMs: Date.now() - start,
      };
    },
  };
}
