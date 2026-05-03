import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createToolsStep } from "@/lib/blueprint/steps/tools";
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

describe("createToolsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("detects Next.js project and includes browser tools", async () => {
    const step = createToolsStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async () =>
      ok(
        JSON.stringify({
          dependencies: { next: "14.0.0", react: "18.0.0" },
          devDependencies: { vitest: "1.0.0" },
        }),
      ),
    );

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("next");
    expect(ctx.toolFlags).toContain("read");
    expect(ctx.toolFlags).toContain("bash");
    expect(ctx.toolFlags).toContain("edit");
    expect(ctx.toolFlags).toContain("write");
    expect(ctx.toolFlags).toContain("lsp");
    expect(ctx.toolFlags).toContain("browser");
    expect(ctx.toolFlags).toContain("test");
  });

  it("returns base tools only for plain Node.js project", async () => {
    const step = createToolsStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async () =>
      ok(
        JSON.stringify({
          dependencies: { express: "4.18.0" },
          devDependencies: {},
        }),
      ),
    );

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.toolFlags).toEqual(["read", "bash", "edit", "write", "lsp"]);
    expect(ctx.toolFlags).not.toContain("browser");
    expect(ctx.toolFlags).not.toContain("test");
  });

  it("returns base tools with success when no package.json exists", async () => {
    const step = createToolsStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async () => fail("No such file"));

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("No package.json");
    expect(ctx.toolFlags).toEqual(["read", "bash", "edit", "write", "lsp"]);
  });

  it("detects test framework and adds test tool flag", async () => {
    const step = createToolsStep();
    const ctx = makeCtx();

    mockExec.mockImplementation(async () =>
      ok(
        JSON.stringify({
          dependencies: {},
          devDependencies: { jest: "29.0.0", typescript: "5.0.0" },
        }),
      ),
    );

    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.toolFlags).toContain("test");
    expect(ctx.toolFlags).not.toContain("browser");
  });
});
