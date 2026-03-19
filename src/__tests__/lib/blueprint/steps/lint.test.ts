import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createLintStep } from "@/lib/blueprint/steps/lint";
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

describe("createLintStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs lint --fix when lint script exists and returns success", async () => {
    const step = createLintStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("cat package.json")) {
        return ok(JSON.stringify({ scripts: { lint: "eslint ." } }));
      }
      if (cmd.includes("npm run lint")) {
        return ok("All files linted");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("Lint autofix completed successfully");

    // Verify lint was called with --fix and 5000ms timeout
    const lintCall = mockExec.mock.calls.find(([, cmd]) => cmd.includes("npm run lint"));
    expect(lintCall).toBeDefined();
    expect(lintCall![1]).toContain("--fix");
    expect(lintCall![2]).toEqual({ timeoutMs: 5_000 });
  });

  it("returns success with skip message when no lint script in package.json", async () => {
    const step = createLintStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("cat package.json")) {
        return ok(JSON.stringify({ scripts: { build: "tsc" } }));
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toBe("No lint script found, skipping");

    // Verify lint was NOT called
    const lintCall = mockExec.mock.calls.find(([, cmd]) => cmd.includes("npm run lint"));
    expect(lintCall).toBeUndefined();
  });

  it("returns success when lint times out (exitCode 124)", async () => {
    const step = createLintStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("cat package.json")) {
        return ok(JSON.stringify({ scripts: { lint: "eslint ." } }));
      }
      if (cmd.includes("npm run lint")) {
        return { stdout: "", stderr: "Command timed out", exitCode: 124 };
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toBe("Lint timed out, continuing");
  });

  it("returns success even when lint command fails (best-effort)", async () => {
    const step = createLintStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("cat package.json")) {
        return ok(JSON.stringify({ scripts: { lint: "eslint ." } }));
      }
      if (cmd.includes("npm run lint")) {
        return fail("ESLint found 5 errors", 2);
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("Lint exited with code 2");
    expect(result.message).toContain("best-effort");
  });
});
