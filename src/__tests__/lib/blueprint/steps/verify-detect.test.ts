import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createVerifyDetectStep } from "@/lib/blueprint/steps/verify-detect";
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

function packageJson(scripts: Record<string, string> = {}): ExecResult {
  return ok(JSON.stringify({ name: "test-project", scripts }));
}

describe("createVerifyDetectStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("detects test-suite when test script exists", async () => {
    mockExec.mockResolvedValue(packageJson({ test: "vitest run" }));

    const step = createVerifyDetectStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.verificationStrategy).toBe("test-suite");
    expect(result.message).toContain("test-suite");
  });

  it("detects test-suite when both test and dev exist (test takes priority)", async () => {
    mockExec.mockResolvedValue(packageJson({ test: "jest", dev: "next dev" }));

    const step = createVerifyDetectStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.verificationStrategy).toBe("test-suite");
  });

  it("detects web-app when dev script exists", async () => {
    mockExec.mockResolvedValue(packageJson({ dev: "next dev" }));

    const step = createVerifyDetectStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.verificationStrategy).toBe("web-app");
  });

  it("detects web-app when start script exists", async () => {
    mockExec.mockResolvedValue(packageJson({ start: "node server.js" }));

    const step = createVerifyDetectStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.verificationStrategy).toBe("web-app");
  });

  it("detects static-site when no package.json but index.html exists", async () => {
    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("package.json")) return fail("No such file");
      if (cmd.includes("index.html")) return ok("");
      return fail();
    });

    const step = createVerifyDetectStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.verificationStrategy).toBe("static-site");
  });

  it("detects none when nothing matches", async () => {
    mockExec.mockResolvedValue(fail("No such file"));

    const step = createVerifyDetectStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.verificationStrategy).toBe("none");
  });

  it("excludes default npm test script from test-suite detection", async () => {
    mockExec.mockImplementation(async (_ws, cmd) => {
      if (cmd.includes("package.json")) {
        return packageJson({ test: 'echo "Error: no test specified" && exit 1' });
      }
      // No index.html either
      return fail("No such file");
    });

    const step = createVerifyDetectStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.verificationStrategy).toBe("none");
  });
});
