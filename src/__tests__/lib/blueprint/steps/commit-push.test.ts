import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createCommitPushStep } from "@/lib/blueprint/steps/commit-push";
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

describe("createCommitPushStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("stages, commits, pushes, and returns success with commit hash", async () => {
    const step = createCommitPushStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("git add -A")) {
        return ok("");
      }
      if (cmd.includes("git commit")) {
        return ok("[hive/task-123 abc1234] hive: Fix the bug in the login form\n 2 files changed");
      }
      if (cmd.includes("git push")) {
        return ok("To github.com:org/repo.git\n * [new branch]");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("abc1234");
    expect(result.message).toContain("hive/task-123");

    // Git identity is configured by Coder's git-config module —
    // no hardcoded git config call expected
    const configCall = mockExec.mock.calls.find(([, cmd]) => cmd.includes("git config user"));
    expect(configCall).toBeUndefined();

    // Verify push uses -u origin <branch>
    const pushCall = mockExec.mock.calls.find(([, cmd]) => cmd.includes("git push"));
    expect(pushCall).toBeDefined();
    expect(pushCall![1]).toContain("git push -u origin hive/task-123");
  });

  it("returns failure when push fails", async () => {
    const step = createCommitPushStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("git add -A")) return ok("");
      if (cmd.includes("git commit")) {
        return ok("[hive/task-123 abc1234] hive: Fix the bug\n 1 file changed");
      }
      if (cmd.includes("git push")) {
        return fail("fatal: Authentication failed for 'https://github.com/org/repo.git'");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Push failed");
    expect(result.message).toContain("Authentication failed");
  });

  it("returns failure when nothing to commit", async () => {
    const step = createCommitPushStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("git add -A")) return ok("");
      if (cmd.includes("git commit")) {
        return { stdout: "nothing to commit, working tree clean", stderr: "", exitCode: 1 };
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Failed to commit");
    expect(result.message).toContain("nothing to commit");
  });

  it("truncates long prompts to 72 chars for the commit subject line", async () => {
    const step = createCommitPushStep();
    const longPrompt = "A".repeat(100);
    const ctx = makeCtx({ prompt: longPrompt });

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("git add -A")) return ok("");
      if (cmd.includes("git commit")) {
        return ok("[branch abc1234] hive: message\n 1 file changed");
      }
      if (cmd.includes("git push")) return ok("");
      return ok("");
    });

    await step.execute(ctx);

    // Commit now uses base64 + git commit -F, so verify via base64 decode
    const commitCall = mockExec.mock.calls.find(([, cmd]) => cmd.includes("git commit"));
    expect(commitCall).toBeDefined();
    const commitCmd = commitCall![1];
    expect(commitCmd).toContain("base64 -d");
    expect(commitCmd).toContain("git commit -F");
    // The full prompt should NOT appear raw in the command
    expect(commitCmd).not.toContain(longPrompt);
  });
});
