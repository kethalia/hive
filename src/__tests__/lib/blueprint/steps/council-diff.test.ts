import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";
vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));
import { createCouncilDiffStep } from "@/lib/blueprint/steps/council-diff";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockExec = vi.mocked(execInWorkspace);

function makeCtx(overrides?: Partial<BlueprintContext>): BlueprintContext {
  return {
    taskId: "test-task-1",
    workspaceName: "council-ws",
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

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "error", exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

const SAMPLE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import foo from './foo';
+import bar from './bar';
 
 export default foo;`;

describe("createCouncilDiffStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns success and sets ctx.councilDiff when diff has content", async () => {
    mockExec.mockResolvedValue(ok(SAMPLE_DIFF));

    const step = createCouncilDiffStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.councilDiff).toBe(SAMPLE_DIFF);
    expect(result.message).toContain("lines");
  });

  it("returns success with empty string when diff is empty (no changes)", async () => {
    mockExec.mockResolvedValue(ok(""));

    const step = createCouncilDiffStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    // Empty diff must be success, not failure
    expect(result.status).toBe("success");
    expect(ctx.councilDiff).toBe("");
    expect(result.message).toContain("Empty diff");
  });

  it("returns failure on git error", async () => {
    mockExec.mockResolvedValue(fail("fatal: not a git repository"));

    const step = createCouncilDiffStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Failed to get diff");
    expect(result.message).toContain("fatal: not a git repository");
    // ctx.councilDiff should not be set on failure
    expect(ctx.councilDiff).toBeUndefined();
  });

  it("uses correct git diff command against origin/main", async () => {
    mockExec.mockResolvedValue(ok(SAMPLE_DIFF));

    const step = createCouncilDiffStep();
    const ctx = makeCtx();
    await step.execute(ctx);

    const cmd = mockExec.mock.calls[0][1];
    expect(cmd).toContain("git diff origin/main...HEAD");
  });

  it("logs with council-diff prefix", async () => {
    mockExec.mockResolvedValue(ok(SAMPLE_DIFF));
    const logSpy = vi.spyOn(console, "log");

    const step = createCouncilDiffStep();
    const ctx = makeCtx();
    await step.execute(ctx);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[blueprint] council-diff:"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("task=test-task-1"));
  });

  it("truncates stderr to 500 chars in failure message", async () => {
    const longStderr = "x".repeat(600);
    mockExec.mockResolvedValue(fail(longStderr));

    const step = createCouncilDiffStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    // message should not contain the full 600-char stderr
    expect(result.message.length).toBeLessThan(600);
  });
});
