import { describe, it, expect, vi, beforeEach } from "vitest";
import { runBlueprint } from "@/lib/blueprint/runner";
import type {
  BlueprintContext,
  BlueprintStep,
  StepResult,
} from "@/lib/blueprint/types";

/** Helper to create a minimal BlueprintContext for testing. */
function makeCtx(overrides?: Partial<BlueprintContext>): BlueprintContext {
  return {
    taskId: "test-task-1",
    workspaceName: "test-ws",
    repoUrl: "https://github.com/org/repo",
    prompt: "Fix the bug",
    branchName: "fix/bug-123",
    assembledContext: "file contents here",
    scopedRules: "use strict mode",
    toolFlags: ["--tool=bash"],
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-20250514",
    ...overrides,
  };
}

/** Helper to create a step that returns a given result. */
function makeStep(
  name: string,
  result: Partial<StepResult> = {},
): BlueprintStep {
  return {
    name,
    execute: vi.fn(async () => ({
      status: "success" as const,
      message: `${name} done`,
      durationMs: 10,
      ...result,
    })),
  };
}

describe("runBlueprint", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns success when all steps succeed", async () => {
    const steps = [makeStep("step-a"), makeStep("step-b"), makeStep("step-c")];
    const result = await runBlueprint(steps, makeCtx());

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((s) => s.name)).toEqual([
      "step-a",
      "step-b",
      "step-c",
    ]);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("stops execution when a step fails — remaining steps not called", async () => {
    const stepA = makeStep("a");
    const stepB = makeStep("b", { status: "failure", message: "b broke" });
    const stepC = makeStep("c");

    const result = await runBlueprint([stepA, stepB, stepC], makeCtx());

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(2); // only a and b
    expect(result.steps[1].status).toBe("failure");
    expect(stepC.execute).not.toHaveBeenCalled();
  });

  it("catches thrown errors and records them as failures", async () => {
    const throwingStep: BlueprintStep = {
      name: "boom",
      execute: async () => {
        throw new Error("unexpected crash");
      },
    };
    const afterStep = makeStep("after");

    const result = await runBlueprint(
      [throwingStep, afterStep],
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe("failure");
    expect(result.steps[0].message).toContain("unexpected crash");
    expect(afterStep.execute).not.toHaveBeenCalled();
  });

  it("continues to next step when a step is skipped", async () => {
    const stepA = makeStep("a", { status: "skipped", message: "not needed" });
    const stepB = makeStep("b");

    const result = await runBlueprint([stepA, stepB], makeCtx());

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].status).toBe("skipped");
    expect(result.steps[1].status).toBe("success");
    expect(stepB.execute).toHaveBeenCalled();
  });

  it("returns success with no step results for empty steps array", async () => {
    const result = await runBlueprint([], makeCtx());

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes context object through to each step", async () => {
    const ctx = makeCtx({ taskId: "ctx-pass-through" });
    const step = makeStep("check-ctx");

    await runBlueprint([step], ctx);

    expect(step.execute).toHaveBeenCalledWith(ctx);
  });
});
