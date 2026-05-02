import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createCouncilCloneStep } from "@/lib/blueprint/steps/council-clone";
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

describe("createCouncilCloneStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns success on successful clone and checkout", async () => {
    mockExec.mockResolvedValue(ok("Cloning into..."));

    const step = createCouncilCloneStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("Cloned and checked out fix/bug-123");
    expect(mockExec).toHaveBeenCalledOnce();

    // Verify base64-encoded values are in the command (injection prevention)
    const cmd = mockExec.mock.calls[0][1];
    const repoB64 = Buffer.from("https://github.com/org/repo").toString("base64");
    const branchB64 = Buffer.from("fix/bug-123").toString("base64");
    expect(cmd).toContain(repoB64);
    expect(cmd).toContain(branchB64);
    expect(cmd).toContain("base64 -d");
  });

  it("command is idempotent — handles existing project directory", async () => {
    mockExec.mockResolvedValue(ok("Already up to date."));

    const step = createCouncilCloneStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");

    // Verify the command includes both clone and fetch/reset paths
    const cmd = mockExec.mock.calls[0][1];
    expect(cmd).toContain("if [ ! -d");
    expect(cmd).toContain("gh repo clone");
    expect(cmd).toContain("git fetch origin");
    expect(cmd).toContain("git reset --hard");
  });

  it("returns failure when repo is not found", async () => {
    mockExec.mockResolvedValue(
      fail("Could not resolve to a Repository with the name 'org/nonexistent'"),
    );

    const step = createCouncilCloneStep();
    const ctx = makeCtx({ repoUrl: "https://github.com/org/nonexistent" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Clone/checkout failed");
    expect(result.message).toContain("Could not resolve");
  });

  it("returns failure when branch does not exist", async () => {
    mockExec.mockResolvedValue(
      fail("error: pathspec 'nonexistent-branch' did not match any file(s)"),
    );

    const step = createCouncilCloneStep();
    const ctx = makeCtx({ branchName: "nonexistent-branch" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Clone/checkout failed");
    expect(result.message).toContain("nonexistent-branch");
  });

  it("does not interpolate repoUrl or branchName directly into shell", async () => {
    mockExec.mockResolvedValue(ok(""));

    const step = createCouncilCloneStep();
    const ctx = makeCtx({
      repoUrl: "https://github.com/org/repo; rm -rf /",
      branchName: "branch$(whoami)",
    });
    await step.execute(ctx);

    // The raw malicious strings should NOT appear in the command
    const cmd = mockExec.mock.calls[0][1];
    expect(cmd).not.toContain("rm -rf /");
    expect(cmd).not.toContain("$(whoami)");
  });

  it("logs with council-clone prefix", async () => {
    mockExec.mockResolvedValue(ok(""));
    const logSpy = vi.spyOn(console, "log");

    const step = createCouncilCloneStep();
    const ctx = makeCtx();
    await step.execute(ctx);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[blueprint] council-clone:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("task=test-task-1"));
  });
});
