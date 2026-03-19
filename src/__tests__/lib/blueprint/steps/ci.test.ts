import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BlueprintContext, BlueprintStep, StepResult } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createCIStep } from "@/lib/blueprint/steps/ci";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockExec = vi.mocked(execInWorkspace);

function makeCtx(overrides?: Partial<BlueprintContext>): BlueprintContext {
  return {
    taskId: "test-task-1",
    workspaceName: "test-ws",
    repoUrl: "https://github.com/org/repo",
    prompt: "Fix the bug",
    branchName: "fix/bug-123",
    assembledContext: "## Repository Structure\nsrc/index.ts",
    scopedRules: "",
    toolFlags: ["read", "bash", "edit"],
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-20250514",
    ...overrides,
  };
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "error", exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

/** Create a mock step that always succeeds. */
function mockStep(name: string, result?: Partial<StepResult>): BlueprintStep {
  return {
    name,
    execute: vi.fn(async () => ({
      status: "success" as const,
      message: `${name} completed`,
      durationMs: 10,
      ...result,
    })),
  };
}

/** Create a mock step that always fails. */
function mockFailStep(name: string, message = "step failed"): BlueprintStep {
  return {
    name,
    execute: vi.fn(async () => ({
      status: "failure" as const,
      message,
      durationMs: 10,
    })),
  };
}

function makeDeps(overrides?: {
  agentStep?: BlueprintStep;
  lintStep?: BlueprintStep;
  commitPushStep?: BlueprintStep;
}) {
  return {
    createAgentStep: vi.fn(() => overrides?.agentStep ?? mockStep("agent-execution")),
    createLintStep: vi.fn(() => overrides?.lintStep ?? mockStep("lint")),
    createCommitPushStep: vi.fn(() => overrides?.commitPushStep ?? mockStep("commit-push")),
  };
}

describe("createCIStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Use fake timers to skip sleep() calls
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: run step.execute while advancing fake timers so sleep() resolves
  async function executeWithTimers(
    step: BlueprintStep,
    ctx: BlueprintContext,
  ): Promise<StepResult> {
    const promise = step.execute(ctx);
    // Flush all pending timers repeatedly until the promise settles
    // This handles the multiple sleep() calls in polling
    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    return promise;
  }

  it("returns success when CI passes on first round", async () => {
    const deps = makeDeps();
    const step = createCIStep(deps);
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh auth status")) {
        return ok("Logged in to github.com");
      }
      if (cmd.includes("gh run list")) {
        return ok(JSON.stringify([
          { status: "completed", conclusion: "success", databaseId: 12345 },
        ]));
      }
      return ok("");
    });

    const result = await executeWithTimers(step, ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("CI passed on round 1");
    expect(ctx.ciRoundsUsed).toBe(1);

    // Agent/lint/push should NOT be re-invoked
    expect(deps.createAgentStep).not.toHaveBeenCalled();
    expect(deps.createLintStep).not.toHaveBeenCalled();
    expect(deps.createCommitPushStep).not.toHaveBeenCalled();
  });

  it("retries and returns success when CI fails then passes on round 2", async () => {
    const deps = makeDeps();
    const step = createCIStep(deps);
    const ctx = makeCtx();

    let ghRunListCallCount = 0;

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh auth status")) {
        return ok("Logged in");
      }
      if (cmd.includes("gh run list")) {
        ghRunListCallCount++;
        if (ghRunListCallCount === 1) {
          // Round 1: CI failed
          return ok(JSON.stringify([
            { status: "completed", conclusion: "failure", databaseId: 100 },
          ]));
        }
        // Round 2: CI passed
        return ok(JSON.stringify([
          { status: "completed", conclusion: "success", databaseId: 101 },
        ]));
      }
      if (cmd.includes("gh run view")) {
        return ok("Error: tests failed\nassert.equal expected 1 got 2");
      }
      return ok("");
    });

    const result = await executeWithTimers(step, ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("CI passed on round 2");
    expect(ctx.ciRoundsUsed).toBe(2);

    // Verify retry steps were invoked
    expect(deps.createAgentStep).toHaveBeenCalledOnce();
    expect(deps.createLintStep).toHaveBeenCalledOnce();
    expect(deps.createCommitPushStep).toHaveBeenCalledOnce();

    // Agent should have received CI failure context
    const agentStep = deps.createAgentStep.mock.results[0].value;
    const agentExecuteCall = (agentStep.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(agentExecuteCall[0].prompt).toContain("CI FAILURE");
    expect(agentExecuteCall[0].prompt).toContain("tests failed");
  });

  it("returns failure with exhaustion message when both rounds fail", async () => {
    const deps = makeDeps();
    const step = createCIStep(deps);
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh auth status")) {
        return ok("Logged in");
      }
      if (cmd.includes("gh run list")) {
        return ok(JSON.stringify([
          { status: "completed", conclusion: "failure", databaseId: 200 },
        ]));
      }
      if (cmd.includes("gh run view")) {
        return ok("TypeError: Cannot read property 'foo' of undefined");
      }
      return ok("");
    });

    const result = await executeWithTimers(step, ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("CI failed after 2 rounds");
    expect(result.message).toContain("TypeError");
    expect(ctx.ciRoundsUsed).toBe(2);
  });

  it("returns failure immediately when gh is not authenticated", async () => {
    const deps = makeDeps();
    const step = createCIStep(deps);
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh auth status")) {
        return fail("You are not logged into any GitHub hosts");
      }
      return ok("");
    });

    const result = await executeWithTimers(step, ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("gh not authenticated");
    expect(ctx.ciRoundsUsed).toBeUndefined();

    // Nothing else should run
    expect(deps.createAgentStep).not.toHaveBeenCalled();
  });

  it("handles no CI run found initially then finds one on retry", async () => {
    const deps = makeDeps();
    const step = createCIStep(deps);
    const ctx = makeCtx();

    let ghRunListCallCount = 0;

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh auth status")) {
        return ok("Logged in");
      }
      if (cmd.includes("gh run list")) {
        ghRunListCallCount++;
        if (ghRunListCallCount <= 2) {
          // First two polls: no runs yet
          return ok("[]");
        }
        // Third poll: run found and completed
        return ok(JSON.stringify([
          { status: "completed", conclusion: "success", databaseId: 300 },
        ]));
      }
      return ok("");
    });

    const result = await executeWithTimers(step, ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("CI passed on round 1");
    expect(ctx.ciRoundsUsed).toBe(1);
    // gh run list should have been called at least 3 times
    const runListCalls = mockExec.mock.calls.filter(([, cmd]) => cmd.includes("gh run list"));
    expect(runListCalls.length).toBeGreaterThanOrEqual(3);
  });
});
