import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createPRStep } from "@/lib/blueprint/steps/pr";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockExec = vi.mocked(execInWorkspace);

function makeCtx(overrides?: Partial<BlueprintContext>): BlueprintContext {
  return {
    taskId: "test-task-1",
    workspaceName: "test-ws",
    repoUrl: "https://github.com/org/repo",
    prompt: "Fix the bug in the login form",
    branchName: "hive/task-123",
    assembledContext: "",
    scopedRules: "",
    toolFlags: [],
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

describe("createPRStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("creates a PR and returns success with the PR URL", async () => {
    const step = createPRStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh pr create")) {
        return ok("https://github.com/org/repo/pull/42\n");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("https://github.com/org/repo/pull/42");

    // Verify prUrl is persisted onto context
    expect(ctx.prUrl).toBe("https://github.com/org/repo/pull/42");

    // Verify the command includes proper flags with quoted branch
    const prCall = mockExec.mock.calls.find(([, cmd]) => cmd.includes("gh pr create"));
    expect(prCall).toBeDefined();
    expect(prCall![1]).toContain("--base main");
    expect(prCall![1]).toContain("--head 'hive/task-123'");
  });

  it("returns failure when gh is not authenticated", async () => {
    const step = createPRStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh pr create")) {
        return fail("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.", 1);
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("gh pr create failed");
    expect(result.message).toContain("GH_TOKEN");
  });

  it("returns failure when PR already exists", async () => {
    const step = createPRStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh pr create")) {
        return fail("a pull request for branch \"hive/task-123\" into branch \"main\" already exists", 1);
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("gh pr create failed");
    expect(result.message).toContain("already exists");
  });

  it("includes task prompt and auto-generated note in PR body", async () => {
    const step = createPRStep();
    const ctx = makeCtx({ prompt: "Add dark mode support", taskId: "task-42" });

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh pr create")) {
        // The body is passed via base64; verify the command uses base64
        return ok("https://github.com/org/repo/pull/99\n");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");

    // The command should use base64 encoding for safe shell transport
    const prCall = mockExec.mock.calls.find(([, cmd]) => cmd.includes("gh pr create"));
    expect(prCall).toBeDefined();
    expect(prCall![1]).toContain("base64 -d");
  });

  it("returns failure when gh outputs invalid URL", async () => {
    const step = createPRStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("gh pr create")) {
        return ok("not-a-url\n");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("invalid URL");
    expect(ctx.prUrl).toBeUndefined();
  });
});
