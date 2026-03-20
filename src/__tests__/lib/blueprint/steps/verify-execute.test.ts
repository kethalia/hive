import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createVerifyExecuteStep } from "@/lib/blueprint/steps/verify-execute";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockExec = vi.mocked(execInWorkspace);

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

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "error", exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

describe("createVerifyExecuteStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("test-suite strategy: npm test passes → outcome pass", async () => {
    mockExec.mockResolvedValue(ok("All tests passed\n5 passed, 0 failed"));

    const step = createVerifyExecuteStep();
    const ctx = makeCtx({ verificationStrategy: "test-suite" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("test-suite");
    expect(result.message).toContain("passed");

    // Check intermediate data stored on ctx
    const intermediate = JSON.parse(ctx.verificationReport!);
    expect(intermediate.outcome).toBe("pass");

    // Should use 120s timeout
    expect(mockExec).toHaveBeenCalledWith(
      "verifier-ws",
      expect.stringContaining("npm test"),
      { timeoutMs: 120_000 },
    );
  });

  it("test-suite strategy: npm test fails → outcome fail", async () => {
    mockExec.mockResolvedValue(fail("FAIL src/index.test.ts\nAssertionError: expected 1 to be 2"));

    const step = createVerifyExecuteStep();
    const ctx = makeCtx({ verificationStrategy: "test-suite" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("failed");

    const intermediate = JSON.parse(ctx.verificationReport!);
    expect(intermediate.outcome).toBe("fail");
  });

  it("web-app strategy: dev server responds → outcome pass", async () => {
    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("npm run dev")) return ok("Server started");
      if (cmd.includes("curl")) return ok("<html>OK</html>");
      if (cmd.includes("browser-screenshot")) return ok("Screenshot saved");
      return ok("");
    });

    const step = createVerifyExecuteStep();
    const ctx = makeCtx({ verificationStrategy: "web-app" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("web-app");
    expect(result.message).toContain("screenshot");

    const intermediate = JSON.parse(ctx.verificationReport!);
    expect(intermediate.outcome).toBe("pass");
  });

  it("web-app strategy: dev server never responds → outcome inconclusive", async () => {
    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("npm run dev")) return ok("");
      if (cmd.includes("curl")) return fail("Connection refused");
      return ok("");
    });

    const step = createVerifyExecuteStep();
    const ctx = makeCtx({ verificationStrategy: "web-app" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("did not respond");

    const intermediate = JSON.parse(ctx.verificationReport!);
    expect(intermediate.outcome).toBe("inconclusive");
  });

  it("none strategy → skipped with inconclusive", async () => {
    const step = createVerifyExecuteStep();
    const ctx = makeCtx({ verificationStrategy: "none" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toBe("No verification strategy found");

    const intermediate = JSON.parse(ctx.verificationReport!);
    expect(intermediate.outcome).toBe("inconclusive");

    // No exec calls for "none"
    expect(mockExec).not.toHaveBeenCalled();
  });
});
