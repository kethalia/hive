import type {
  BlueprintContext,
  BlueprintResult,
  BlueprintStep,
  StepResult,
} from "./types";

/**
 * Run a sequence of blueprint steps against a workspace context.
 *
 * Steps execute sequentially. On failure (returned or thrown), execution
 * stops immediately — remaining steps are not called. Skipped steps are
 * logged and execution continues.
 */
export async function runBlueprint(
  steps: BlueprintStep[],
  ctx: BlueprintContext,
): Promise<BlueprintResult> {
  const startTime = Date.now();
  const completedSteps: Array<{ name: string } & StepResult> = [];

  for (const step of steps) {
    console.log(`[blueprint] Starting step: ${step.name} (task=${ctx.taskId})`);
    const stepStart = Date.now();

    let result: StepResult;
    try {
      result = await step.execute(ctx);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      result = {
        status: "failure",
        message: `Step threw: ${message}`,
        durationMs: Date.now() - stepStart,
      };
    }

    completedSteps.push({ name: step.name, ...result });

    if (result.status === "failure") {
      console.log(
        `[blueprint] Step failed: ${step.name} — ${result.message} (task=${ctx.taskId}, ${result.durationMs}ms)`,
      );
      return {
        success: false,
        steps: completedSteps,
        totalDurationMs: Date.now() - startTime,
      };
    }

    if (result.status === "skipped") {
      console.log(
        `[blueprint] Step skipped: ${step.name} — ${result.message} (task=${ctx.taskId})`,
      );
    } else {
      console.log(
        `[blueprint] Step completed: ${step.name} (task=${ctx.taskId}, ${result.durationMs}ms)`,
      );
    }
  }

  return {
    success: true,
    steps: completedSteps,
    totalDurationMs: Date.now() - startTime,
  };
}
