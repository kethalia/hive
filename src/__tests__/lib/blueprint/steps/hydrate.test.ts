import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

// Mock the exec module boundary (not child_process)
vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createHydrateStep } from "@/lib/blueprint/steps/hydrate";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockExec = vi.mocked(execInWorkspace);

function makeCtx(overrides?: Partial<BlueprintContext>): BlueprintContext {
  return {
    taskId: "test-task-1",
    workspaceName: "test-ws",
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

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "error"): ExecResult {
  return { stdout: "", stderr, exitCode: 1 };
}

describe("createHydrateStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("assembles context from tree + key files on success", async () => {
    const step = createHydrateStep();
    const ctx = makeCtx();

    // find returns file tree
    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.startsWith("find")) {
        return ok("src/index.ts\nsrc/app.tsx\nsrc/utils.py");
      }
      if (cmd.includes("test -f") && cmd.includes("README.md")) {
        return ok("exists");
      }
      if (cmd.includes("test -f") && cmd.includes("package.json")) {
        return ok("exists");
      }
      if (cmd.includes("test -f")) {
        return ok(""); // other files don't exist
      }
      if (cmd.includes("cat") && cmd.includes("README.md")) {
        return ok("# My Project\nA great project.");
      }
      if (cmd.includes("cat") && cmd.includes("package.json")) {
        return ok('{"name": "my-app"}');
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("3 tree files");
    expect(result.message).toContain("2 key files");
    expect(ctx.assembledContext).toContain("## Repository Structure");
    expect(ctx.assembledContext).toContain("src/index.ts");
    expect(ctx.assembledContext).toContain("## Key Files");
    expect(ctx.assembledContext).toContain("### README.md");
    expect(ctx.assembledContext).toContain("# My Project");
    expect(ctx.assembledContext).toContain("### package.json");
  });

  it("returns failure when repo directory doesn't exist", async () => {
    const step = createHydrateStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async () => fail("No such file or directory"));

    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Failed to list repo files");
  });

  it("succeeds with partial context when optional files are missing", async () => {
    const step = createHydrateStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.startsWith("find")) {
        return ok("main.go");
      }
      // All test -f checks return not-exists
      if (cmd.includes("test -f")) {
        return ok("");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("1 tree files");
    expect(result.message).toContain("0 key files");
    expect(ctx.assembledContext).toContain("## Repository Structure");
    expect(ctx.assembledContext).toContain("main.go");
    // No Key Files section when no files found
    expect(ctx.assembledContext).not.toContain("## Key Files");
  });

  it("context string contains both repo tree and file contents", async () => {
    const step = createHydrateStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.startsWith("find")) {
        return ok("src/lib.ts");
      }
      if (cmd.includes("test -f") && cmd.includes("AGENTS.md")) {
        return ok("exists");
      }
      if (cmd.includes("test -f")) {
        return ok("");
      }
      if (cmd.includes("cat") && cmd.includes("AGENTS.md")) {
        return ok("Always use TypeScript strict mode.");
      }
      return ok("");
    });

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.assembledContext).toContain("## Repository Structure");
    expect(ctx.assembledContext).toContain("src/lib.ts");
    expect(ctx.assembledContext).toContain("### AGENTS.md");
    expect(ctx.assembledContext).toContain("Always use TypeScript strict mode.");
  });
});
