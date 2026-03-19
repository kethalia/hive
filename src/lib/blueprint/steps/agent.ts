import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintStep } from "../types";

const PROJECT_DIR = "/home/coder/project";

/** 30-minute timeout — complex tasks can run long. */
const AGENT_TIMEOUT_MS = 1_800_000;

/**
 * Create the agent execution step (R003).
 *
 * Writes the assembled context + scoped rules to a temp file in the
 * workspace, then runs Pi in `--print --no-session` mode, piping the
 * context via stdin. After Pi completes, verifies code changes exist
 * via `git diff --stat`.
 */
export function createAgentStep(): BlueprintStep {
  return {
    name: "agent-execution",
    async execute(ctx) {
      const start = Date.now();

      // 1. Write assembled context + rules to a temp file via base64
      //    to avoid any shell quoting/escaping issues.
      const contextPayload = [ctx.assembledContext, ctx.scopedRules]
        .filter(Boolean)
        .join("\n\n");
      const b64 = Buffer.from(contextPayload, "utf-8").toString("base64");

      const writeResult = await execInWorkspace(
        ctx.workspaceName,
        `echo '${b64}' | base64 -d > /tmp/hive-context.md`,
        { timeoutMs: 30_000 },
      );

      if (writeResult.exitCode !== 0) {
        return {
          status: "failure",
          message: `Failed to write context file: ${writeResult.stderr.slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }

      console.log(
        `[blueprint] agent-execution: wrote ${contextPayload.length} chars to /tmp/hive-context.md (task=${ctx.taskId})`,
      );

      // 2. Build and run the Pi command
      //    Truncate prompt in logs to 200 chars for redaction constraints.
      const truncatedPrompt =
        ctx.prompt.length > 200 ? ctx.prompt.slice(0, 200) + "…" : ctx.prompt;
      console.log(
        `[blueprint] agent-execution: running pi --print (task=${ctx.taskId}, prompt="${truncatedPrompt}")`,
      );

      // 2b. Write prompt to a temp file via base64 to avoid shell injection.
      //     The prompt originates from user input — never interpolate it
      //     into a shell string.
      const promptPayload = `Based on the following context, implement this task: ${ctx.prompt}`;
      const promptB64 = Buffer.from(promptPayload, "utf-8").toString("base64");

      const writePromptResult = await execInWorkspace(
        ctx.workspaceName,
        `echo '${promptB64}' | base64 -d > /tmp/hive-prompt.txt`,
        { timeoutMs: 30_000 },
      );

      if (writePromptResult.exitCode !== 0) {
        return {
          status: "failure",
          message: `Failed to write prompt file: ${writePromptResult.stderr.slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }

      const toolArgs = ctx.toolFlags.map((t) => `--tool=${t}`).join(" ");
      const piCmd = [
        `cd ${PROJECT_DIR}`,
        `&&`,
        `cat /tmp/hive-context.md`,
        `|`,
        `pi -p --no-session`,
        `--provider ${ctx.piProvider}`,
        `--model ${ctx.piModel}`,
        toolArgs,
        `"$(cat /tmp/hive-prompt.txt)"`,
      ].join(" ");

      const piResult = await execInWorkspace(ctx.workspaceName, piCmd, {
        timeoutMs: AGENT_TIMEOUT_MS,
      });

      if (piResult.exitCode !== 0) {
        return {
          status: "failure",
          message: `Pi exited with code ${piResult.exitCode}: ${piResult.stderr.slice(0, 500)}`,
          durationMs: Date.now() - start,
        };
      }

      // 3. Verify code changes exist
      const diffResult = await execInWorkspace(
        ctx.workspaceName,
        `cd ${PROJECT_DIR} && git diff --stat`,
        { timeoutMs: 30_000 },
      );

      const hasChanges =
        diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0;

      if (!hasChanges) {
        return {
          status: "failure",
          message: "Agent completed but produced no code changes",
          durationMs: Date.now() - start,
        };
      }

      console.log(
        `[blueprint] agent-execution: code changes detected (task=${ctx.taskId})\n${diffResult.stdout.trim()}`,
      );

      return {
        status: "success",
        message: `Agent produced code changes:\n${diffResult.stdout.trim()}`,
        durationMs: Date.now() - start,
      };
    },
  };
}
