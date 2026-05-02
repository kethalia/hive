import {
  AGENT_OUTPUT_LOG,
  AGENT_TIMEOUT_MS,
  CONTEXT_FILE,
  EXEC_TIMEOUT_MS,
  PROJECT_DIR,
  PROMPT_FILE,
  SAFE_IDENTIFIER_RE,
} from "@/lib/constants";
import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintStep } from "../types";

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

      // Validate provider and model — these are interpolated into a shell command.
      // Currently sourced from env vars, but validate defensively in case the
      // trust boundary shifts to user/task configuration.
      if (!SAFE_IDENTIFIER_RE.test(ctx.piProvider)) {
        return {
          status: "failure" as const,
          message: `Invalid piProvider value: ${ctx.piProvider}`,
          durationMs: Date.now() - start,
        };
      }
      if (!SAFE_IDENTIFIER_RE.test(ctx.piModel)) {
        return {
          status: "failure" as const,
          message: `Invalid piModel value: ${ctx.piModel}`,
          durationMs: Date.now() - start,
        };
      }

      // 1. Write assembled context + rules to a temp file via base64
      //    to avoid any shell quoting/escaping issues.
      const contextPayload = [ctx.assembledContext, ctx.scopedRules].filter(Boolean).join("\n\n");
      const b64 = Buffer.from(contextPayload, "utf-8").toString("base64");

      const writeResult = await execInWorkspace(
        ctx.workspaceName,
        `echo '${b64}' | base64 -d > ${CONTEXT_FILE}`,
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      if (writeResult.exitCode !== 0) {
        return {
          status: "failure",
          message: `Failed to write context file: ${writeResult.stderr.slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }

      console.log(
        `[blueprint] agent-execution: wrote ${contextPayload.length} chars to ${CONTEXT_FILE} (task=${ctx.taskId})`,
      );

      // 2. Build and run the Pi command
      //    Truncate prompt in logs to 200 chars for redaction constraints.
      const truncatedPrompt = ctx.prompt.length > 200 ? `${ctx.prompt.slice(0, 200)}…` : ctx.prompt;
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
        `echo '${promptB64}' | base64 -d > ${PROMPT_FILE}`,
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      if (writePromptResult.exitCode !== 0) {
        return {
          status: "failure",
          message: `Failed to write prompt file: ${writePromptResult.stderr.slice(0, 200)}`,
          durationMs: Date.now() - start,
        };
      }

      // Ensure the agent output log file exists before Pi starts,
      // so `tail -f` from the SSE endpoint doesn't fail if it connects early.
      const initLogResult = await execInWorkspace(ctx.workspaceName, `: > ${AGENT_OUTPUT_LOG}`, {
        timeoutMs: EXEC_TIMEOUT_MS,
      });

      if (initLogResult.exitCode !== 0) {
        console.log(
          `[blueprint] agent-execution: warning — failed to init log file: ${initLogResult.stderr.slice(0, 200)}`,
        );
      }

      const toolArgs = ctx.toolFlags.map((t) => `--tool=${t}`).join(" ");
      // set -o pipefail ensures the exit code reflects Pi's status,
      // not tee's (which almost always returns 0).
      const piCmd = [
        `set -o pipefail`,
        `&&`,
        `cd ${PROJECT_DIR}`,
        `&&`,
        `cat ${CONTEXT_FILE}`,
        `|`,
        `pi -p --no-session`,
        `--provider ${ctx.piProvider}`,
        `--model ${ctx.piModel}`,
        toolArgs,
        `"$(cat ${PROMPT_FILE})"`,
        `| tee ${AGENT_OUTPUT_LOG}`,
      ].join(" ");

      const piResult = await execInWorkspace(ctx.workspaceName, piCmd, {
        timeoutMs: AGENT_TIMEOUT_MS,
        loginShell: true,
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
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      const hasChanges = diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0;

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
