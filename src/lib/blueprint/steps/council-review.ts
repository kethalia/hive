import { AGENT_TIMEOUT_MS, COUNCIL_PROMPT_FILE, EXEC_TIMEOUT_MS } from "@/lib/constants";
import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintContext, BlueprintStep } from "../types";

/**
 * Create the council-review step.
 *
 * Writes a review prompt (instructing Claude to return structured JSON findings)
 * to a temp file via base64, then invokes `claude --print` to perform the review.
 * Stores raw Claude output on `ctx.councilFindings` for the council-emit step.
 *
 * Empty diff case: skips Claude invocation entirely and sets findings to
 * `{ findings: [] }` — matching the council-diff empty-diff contract.
 */
export function createCouncilReviewStep(): BlueprintStep {
  return {
    name: "council-review",
    async execute(ctx: BlueprintContext) {
      const start = Date.now();

      // Empty diff — skip Claude, set empty findings
      if (ctx.councilDiff === "") {
        ctx.councilFindings = JSON.stringify({ findings: [] });
        const msg = "Empty diff — skipping review";
        console.log(`[blueprint] council-review: ${msg} (task=${ctx.taskId})`);
        return { status: "success", message: msg, durationMs: Date.now() - start };
      }

      // Build review prompt instructing Claude to return ONLY valid JSON
      const prompt = [
        "You are a code reviewer. Your task is to review the following diff and identify issues.",
        "",
        "IMPORTANT: You MUST respond with ONLY valid JSON matching this exact schema — no prose, no markdown, no code fences:",
        '{ "findings": [ { "file": string, "startLine": number, "severity": "critical"|"major"|"minor"|"nit", "issue": string, "fix": string, "reasoning": string } ] }',
        "",
        'If there are no issues to report, return: { "findings": [] }',
        "",
        "Here is the diff to review:",
        "<diff>",
        ctx.councilDiff ?? "",
        "</diff>",
        "",
        "Respond ONLY with the JSON object. No explanation, no markdown, no preamble.",
      ].join("\n");

      // Base64-encode the prompt to avoid shell injection (diff contains user code)
      const promptB64 = Buffer.from(prompt, "utf-8").toString("base64");

      const writeResult = await execInWorkspace(
        ctx.workspaceName,
        `echo '${promptB64}' | base64 -d > ${COUNCIL_PROMPT_FILE}`,
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      if (writeResult.exitCode !== 0) {
        const msg = `Failed to write prompt file: ${writeResult.stderr.slice(0, 200)}`;
        console.log(`[blueprint] council-review: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      console.log(
        `[blueprint] council-review: wrote prompt to ${COUNCIL_PROMPT_FILE} (task=${ctx.taskId})`,
      );

      // Invoke Claude with the prompt file via stdin to avoid shell interpolation
      // of untrusted diff content (the file may contain shell metacharacters)
      const claudeResult = await execInWorkspace(
        ctx.workspaceName,
        `cat ${COUNCIL_PROMPT_FILE} | claude --print -`,
        { timeoutMs: AGENT_TIMEOUT_MS, loginShell: true },
      );

      if (claudeResult.exitCode !== 0) {
        const msg = `Claude exited with code ${claudeResult.exitCode}: ${claudeResult.stderr.slice(0, 500)}`;
        console.log(`[blueprint] council-review: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      ctx.councilFindings = claudeResult.stdout;

      const msg = `Review complete (${claudeResult.stdout.length} chars)`;
      console.log(`[blueprint] council-review: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs: Date.now() - start };
    },
  };
}
