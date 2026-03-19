import { execInWorkspace } from "@/lib/workspace/exec";
import type { BlueprintContext, BlueprintStep, StepResult } from "../types";

const PROJECT_DIR = "/home/coder/project";

/** Initial delay before first CI poll — GitHub Actions needs time to register runs. */
const INITIAL_DELAY_MS = 10_000;

/** Maximum time to poll for a single CI round. */
const POLL_TIMEOUT_MS = 600_000; // 10 minutes

/** Backoff schedule: 5s → 10s → 20s → 30s cap. */
const BACKOFF_INTERVALS_MS = [5_000, 10_000, 20_000, 30_000];

/** Max characters of CI failure logs to feed back to agent. */
const MAX_FAILURE_LOG_CHARS = 3_000;

/** Timeout for individual gh CLI commands. */
const GH_CMD_TIMEOUT_MS = 30_000;

/** Max rounds of CI retry. */
const MAX_ROUNDS = 2;

interface CIStepDeps {
  createAgentStep: () => BlueprintStep;
  createLintStep: () => BlueprintStep;
  createCommitPushStep: () => BlueprintStep;
}

interface RunInfo {
  status: string;
  conclusion: string | null;
  databaseId: number;
}

/**
 * Sleep for the given duration. Uses a real timer — tests should mock this
 * via vi.useFakeTimers or by keeping delays at 0 via fast-forward.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the CI feedback composite step (R029).
 *
 * Polls GitHub Actions for CI results after a push. If CI fails, extracts
 * failure logs, re-invokes the agent with failure context, re-lints,
 * re-pushes, and polls again. Caps at 2 rounds total.
 *
 * Dependencies are injected so tests can provide mocks and to avoid
 * circular imports.
 */
export function createCIStep(deps: CIStepDeps): BlueprintStep {
  return {
    name: "ci-feedback",
    async execute(ctx: BlueprintContext): Promise<StepResult> {
      const start = Date.now();
      const log = (msg: string) =>
        console.log(`[blueprint] ci-feedback: ${msg} (task=${ctx.taskId})`);

      // 1. Check gh auth
      const authResult = await execInWorkspace(
        ctx.workspaceName,
        "gh auth status",
        { timeoutMs: GH_CMD_TIMEOUT_MS },
      );

      if (authResult.exitCode !== 0) {
        const msg = `gh not authenticated: ${authResult.stderr.slice(0, 200)}`;
        log(msg);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      log("gh authenticated, starting CI polling");

      // 2. Run up to MAX_ROUNDS
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        log(`round ${round}: waiting for CI on branch ${ctx.branchName}`);

        const pollResult = await pollForCIResult(ctx, log);

        if (pollResult.status === "timeout") {
          ctx.ciRoundsUsed = round;
          const msg = `CI polling timed out on round ${round} after ${POLL_TIMEOUT_MS / 1000}s`;
          log(msg);
          return { status: "failure", message: msg, durationMs: Date.now() - start };
        }

        if (pollResult.status === "success") {
          ctx.ciRoundsUsed = round;
          const msg = `CI passed on round ${round}`;
          log(msg);
          return { status: "success", message: msg, durationMs: Date.now() - start };
        }

        // CI failed — extract logs
        log(`round ${round}: CI failed (run ${pollResult.runId}), extracting logs`);
        const failureLogs = await extractFailureLogs(ctx, pollResult.runId!);

        // If this is the last round, don't retry
        if (round === MAX_ROUNDS) {
          ctx.ciRoundsUsed = round;
          const msg = `CI failed after ${MAX_ROUNDS} rounds. Last failure:\n${failureLogs.slice(0, 500)}`;
          log(`exhaustion after ${MAX_ROUNDS} rounds`);
          return { status: "failure", message: msg, durationMs: Date.now() - start };
        }

        // Retry: re-invoke agent with failure context, re-lint, re-push
        log(`round ${round}: triggering retry — re-invoking agent with CI failure context`);

        const retryResult = await runRetry(ctx, deps, failureLogs, log);
        if (retryResult.status === "failure") {
          ctx.ciRoundsUsed = round;
          return { ...retryResult, durationMs: Date.now() - start };
        }

        // Retry succeeded (agent + lint + push done) — loop back to poll round 2
      }

      // Should not reach here, but safety net
      ctx.ciRoundsUsed = MAX_ROUNDS;
      return {
        status: "failure",
        message: "CI feedback loop ended unexpectedly",
        durationMs: Date.now() - start,
      };
    },
  };
}

interface PollResult {
  status: "success" | "failure" | "timeout";
  runId?: number;
}

/**
 * Poll GitHub Actions for CI completion on the given branch.
 * Uses exponential backoff: 5s → 10s → 20s → 30s cap.
 */
async function pollForCIResult(
  ctx: BlueprintContext,
  log: (msg: string) => void,
): Promise<PollResult> {
  const pollStart = Date.now();

  // Initial delay — let GitHub Actions register the run
  log("initial delay before polling");
  await sleep(INITIAL_DELAY_MS);

  let attempt = 0;

  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    const result = await execInWorkspace(
      ctx.workspaceName,
      `cd ${PROJECT_DIR} && gh run list --branch ${ctx.branchName} --limit 1 --json status,conclusion,databaseId`,
      { timeoutMs: GH_CMD_TIMEOUT_MS },
    );

    if (result.exitCode === 0 && result.stdout.trim()) {
      let runs: RunInfo[];
      try {
        runs = JSON.parse(result.stdout.trim());
      } catch {
        log(`failed to parse gh run list output, retrying`);
        runs = [];
      }

      if (runs.length > 0) {
        const run = runs[0];

        if (run.status === "completed") {
          if (run.conclusion === "success") {
            return { status: "success", runId: run.databaseId };
          }
          // Any non-success conclusion is a failure
          return { status: "failure", runId: run.databaseId };
        }

        log(`run ${run.databaseId} status=${run.status}, waiting...`);
      } else {
        log("no CI runs found yet, waiting...");
      }
    } else {
      log("gh run list returned no results, waiting...");
    }

    // Backoff sleep
    const backoffIdx = Math.min(attempt, BACKOFF_INTERVALS_MS.length - 1);
    const interval = BACKOFF_INTERVALS_MS[backoffIdx];
    await sleep(interval);
    attempt++;
  }

  return { status: "timeout" };
}

/**
 * Extract failure logs from a CI run, truncated to MAX_FAILURE_LOG_CHARS.
 */
async function extractFailureLogs(
  ctx: BlueprintContext,
  runId: number,
): Promise<string> {
  const result = await execInWorkspace(
    ctx.workspaceName,
    `cd ${PROJECT_DIR} && gh run view ${runId} --log-failed`,
    { timeoutMs: GH_CMD_TIMEOUT_MS },
  );

  if (result.exitCode !== 0) {
    return `Failed to extract CI logs: ${result.stderr.slice(0, 200)}`;
  }

  const logs = result.stdout.trim();
  return logs.length > MAX_FAILURE_LOG_CHARS
    ? logs.slice(0, MAX_FAILURE_LOG_CHARS) + "\n... (truncated)"
    : logs;
}

/**
 * Run the retry cycle: agent (with CI failure context) → lint → commit-push.
 */
async function runRetry(
  ctx: BlueprintContext,
  deps: CIStepDeps,
  failureLogs: string,
  log: (msg: string) => void,
): Promise<StepResult> {
  // Augment context with CI failure information for the agent
  const retryCtx: BlueprintContext = {
    ...ctx,
    prompt: `${ctx.prompt}\n\n--- CI FAILURE (fix this) ---\nThe previous push failed CI. Here are the failure logs:\n\n${failureLogs}\n\nPlease fix the issues and ensure CI passes.`,
  };

  // 1. Re-invoke agent with failure context
  const agentStep = deps.createAgentStep();
  log("retry: running agent with CI failure context");
  const agentResult = await agentStep.execute(retryCtx);
  if (agentResult.status === "failure") {
    log(`retry: agent failed — ${agentResult.message.slice(0, 100)}`);
    return {
      status: "failure",
      message: `Agent retry failed: ${agentResult.message}`,
      durationMs: 0, // caller will set real duration
    };
  }

  // 2. Re-lint
  const lintStep = deps.createLintStep();
  log("retry: running lint");
  await lintStep.execute(ctx); // lint always succeeds (best-effort)

  // 3. Re-push
  const commitPushStep = deps.createCommitPushStep();
  log("retry: running commit-push");
  const pushResult = await commitPushStep.execute(ctx);
  if (pushResult.status === "failure") {
    log(`retry: commit-push failed — ${pushResult.message.slice(0, 100)}`);
    return {
      status: "failure",
      message: `Commit-push retry failed: ${pushResult.message}`,
      durationMs: 0,
    };
  }

  log("retry: agent + lint + push completed, polling for CI again");
  return { status: "success", message: "Retry cycle completed", durationMs: 0 };
}
