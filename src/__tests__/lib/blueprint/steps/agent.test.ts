import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createAgentStep } from "@/lib/blueprint/steps/agent";
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
    scopedRules: "## Rules\nUse TypeScript strict mode.",
    toolFlags: ["read", "bash", "edit", "write", "lsp"],
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

describe("createAgentStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("writes context to temp file, runs pi, and succeeds when code changes exist", async () => {
    const step = createAgentStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      // base64 write to context temp file
      if (cmd.includes("base64 -d > /tmp/hive-context.md")) {
        return ok("");
      }
      // base64 write to prompt temp file
      if (cmd.includes("base64 -d > /tmp/hive-prompt.txt")) {
        return ok("");
      }
      // Pi execution
      if (cmd.includes("pi -p --no-session")) {
        return ok("Done implementing changes.");
      }
      // git diff --stat
      if (cmd.includes("git diff --stat")) {
        return ok(" src/index.ts | 10 +++++++---\n 1 file changed, 7 insertions(+), 3 deletions(-)");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("Agent produced code changes");
    expect(result.message).toContain("src/index.ts");

    // Verify context was written as base64
    const writeCall = mockExec.mock.calls.find(
      ([, cmd]) => cmd.includes("base64 -d > /tmp/hive-context.md"),
    );
    expect(writeCall).toBeDefined();

    // Verify Pi was invoked with correct flags
    const piCall = mockExec.mock.calls.find(
      ([, cmd]) => cmd.includes("pi -p --no-session"),
    );
    expect(piCall).toBeDefined();
    const piCmd = piCall![1];
    expect(piCmd).toContain("--provider anthropic");
    expect(piCmd).toContain("--model claude-sonnet-4-20250514");
    expect(piCmd).toContain("--tool=read");
    expect(piCmd).toContain("cat /tmp/hive-context.md");
  });

  it("returns failure when Pi exits with non-zero code", async () => {
    const step = createAgentStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("base64 -d > /tmp/hive-context.md")) {
        return ok("");
      }
      if (cmd.includes("base64 -d > /tmp/hive-prompt.txt")) {
        return ok("");
      }
      if (cmd.includes("pi -p --no-session")) {
        return fail("Error: API rate limit exceeded", 1);
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Pi exited with code 1");
    expect(result.message).toContain("API rate limit exceeded");
  });

  it("returns failure when Pi succeeds but produces no code changes", async () => {
    const step = createAgentStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("base64 -d > /tmp/hive-context.md")) {
        return ok("");
      }
      if (cmd.includes("base64 -d > /tmp/hive-prompt.txt")) {
        return ok("");
      }
      if (cmd.includes("pi -p --no-session")) {
        return ok("I analyzed the code but found nothing to change.");
      }
      if (cmd.includes("git diff --stat")) {
        return ok(""); // empty diff
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toBe("Agent completed but produced no code changes");
  });

  it("returns failure when context file write fails", async () => {
    const step = createAgentStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("base64 -d > /tmp/hive-context.md")) {
        return fail("Permission denied");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Failed to write context file");
    expect(result.message).toContain("Permission denied");
  });

  it("uses 30-minute timeout for Pi execution", async () => {
    const step = createAgentStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("base64 -d > /tmp/hive-context.md")) {
        return ok("");
      }
      if (cmd.includes("base64 -d > /tmp/hive-prompt.txt")) {
        return ok("");
      }
      if (cmd.includes("pi -p --no-session")) {
        return ok("Done.");
      }
      if (cmd.includes("git diff --stat")) {
        return ok(" file.ts | 1 +\n 1 file changed");
      }
      return ok("");
    });

    await step.execute(ctx);

    // The Pi command should use 1_800_000ms timeout
    const piCall = mockExec.mock.calls.find(
      ([, cmd]) => cmd.includes("pi -p --no-session"),
    );
    expect(piCall).toBeDefined();
    expect(piCall![2]).toEqual({ timeoutMs: 1_800_000 });
  });
});
