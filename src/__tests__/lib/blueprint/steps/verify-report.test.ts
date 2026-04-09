import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import { createVerifyReportStep } from "@/lib/blueprint/steps/verify-report";

function makeCtx(overrides?: Partial<BlueprintContext>): BlueprintContext {
  return {
    taskId: "test-task-1",
    workspaceName: "verifier-ws",
    repoUrl: "https://github.com/org/repo",
    prompt: "Fix the bug",
    branchName: "fix/bug-123",
    assembledContext: "",
    scopedRules: "",
    toolFlags: [],
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-20250514",
    ...overrides,
  };
}

describe("createVerifyReportStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("assembles report with correct strategy and outcome", async () => {
    const step = createVerifyReportStep();
    const ctx = makeCtx({
      verificationStrategy: "test-suite",
      verificationReport: JSON.stringify({ outcome: "pass", logs: "All tests passed", durationMs: 5000 }),
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("strategy=test-suite");
    expect(result.message).toContain("outcome=pass");

    const report = JSON.parse(ctx.verificationReport!);
    expect(report.strategy).toBe("test-suite");
    expect(report.outcome).toBe("pass");
    expect(report.logs).toBe("All tests passed");
    // durationMs should come from the execute step, not report step timing
    expect(report.durationMs).toBe(5000);
  });

  it("report includes timestamp and duration", async () => {
    const step = createVerifyReportStep();
    const ctx = makeCtx({
      verificationStrategy: "web-app",
      verificationReport: JSON.stringify({ outcome: "pass", logs: "", durationMs: 1234 }),
    });

    const result = await step.execute(ctx);

    const report = JSON.parse(ctx.verificationReport!);
    expect(report.timestamp).toBeDefined();
    expect(typeof report.timestamp).toBe("string");
    // Verify it's a valid ISO date
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    expect(typeof report.durationMs).toBe("number");
    expect(report.durationMs).toBe(1234);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("produces inconclusive report when intermediate data is missing", async () => {
    const step = createVerifyReportStep();
    const ctx = makeCtx();
    // No verificationReport or verificationStrategy set

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");

    const report = JSON.parse(ctx.verificationReport!);
    expect(report.strategy).toBe("none");
    expect(report.outcome).toBe("inconclusive");
    expect(report.logs).toBe("");
  });
});
