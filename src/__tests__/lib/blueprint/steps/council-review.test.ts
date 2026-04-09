import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ExecResult } from "@/lib/workspace/exec";

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { createCouncilReviewStep } from "@/lib/blueprint/steps/council-review";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockExec = vi.mocked(execInWorkspace);

const SAMPLE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import foo from './foo';
+import bar from './bar';
 
 export default foo;`;

const SAMPLE_FINDINGS_JSON = JSON.stringify({
  findings: [
    {
      file: "src/index.ts",
      startLine: 2,
      severity: "minor",
      issue: "Missing type annotation",
      fix: "Add explicit type annotation",
      reasoning: "Improves readability",
    },
  ],
});

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
    councilDiff: SAMPLE_DIFF,
    ...overrides,
  };
}

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr = "error", exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

describe("createCouncilReviewStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("happy path: prompt write succeeds + claude returns valid JSON → success with ctx.councilFindings set", async () => {
    // First call: write prompt file; second call: claude --print
    mockExec
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(SAMPLE_FINDINGS_JSON));

    const step = createCouncilReviewStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(ctx.councilFindings).toBe(SAMPLE_FINDINGS_JSON);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("empty diff path: skips Claude invocation, sets ctx.councilFindings to empty findings", async () => {
    const step = createCouncilReviewStep();
    const ctx = makeCtx({ councilDiff: "" });
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(result.message).toContain("Empty diff");
    expect(ctx.councilFindings).toBe(JSON.stringify({ findings: [] }));
    // execInWorkspace must NOT be called at all
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("claude exits non-zero → step failure with stderr excerpt", async () => {
    mockExec
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(fail("API rate limit exceeded", 1));

    const step = createCouncilReviewStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("API rate limit exceeded");
    // councilFindings must not be set on failure
    expect(ctx.councilFindings).toBeUndefined();
  });

  it("prompt file write fails → step failure", async () => {
    mockExec.mockResolvedValueOnce(fail("Permission denied", 1));

    const step = createCouncilReviewStep();
    const ctx = makeCtx();
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Failed to write prompt file");
    // Claude should not be invoked if write fails
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(ctx.councilFindings).toBeUndefined();
  });

  it("prompt contains <diff> tags with the diff content", async () => {
    mockExec
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(SAMPLE_FINDINGS_JSON));

    const step = createCouncilReviewStep();
    const ctx = makeCtx();
    await step.execute(ctx);

    // The first exec call writes the prompt via base64
    const writeCmd = mockExec.mock.calls[0][1];
    // Decode the base64 to inspect prompt contents
    const b64Match = writeCmd.match(/echo '([^']+)' \| base64 -d/);
    expect(b64Match).not.toBeNull();
    const decoded = Buffer.from(b64Match![1], "base64").toString("utf-8");
    expect(decoded).toContain("<diff>");
    expect(decoded).toContain("</diff>");
    expect(decoded).toContain(SAMPLE_DIFF);
  });

  it("prompt contains JSON schema instructions", async () => {
    mockExec
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(SAMPLE_FINDINGS_JSON));

    const step = createCouncilReviewStep();
    const ctx = makeCtx();
    await step.execute(ctx);

    const writeCmd = mockExec.mock.calls[0][1];
    const b64Match = writeCmd.match(/echo '([^']+)' \| base64 -d/);
    expect(b64Match).not.toBeNull();
    const decoded = Buffer.from(b64Match![1], "base64").toString("utf-8");
    expect(decoded).toContain("findings");
    expect(decoded).toContain("startLine");
    expect(decoded).toContain("severity");
    // Must instruct Claude to return ONLY JSON
    expect(decoded.toLowerCase()).toContain("only");
  });

  it("uses base64 encoding for prompt to prevent shell injection", async () => {
    mockExec
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(SAMPLE_FINDINGS_JSON));

    const step = createCouncilReviewStep();
    const ctx = makeCtx({
      councilDiff: "diff with $(dangerous) `shell` injection",
    });
    await step.execute(ctx);

    const writeCmd = mockExec.mock.calls[0][1];
    // Command must use base64 decode pattern
    expect(writeCmd).toContain("base64 -d");
    // Raw injection payloads must not appear literally in the shell command
    expect(writeCmd).not.toContain("$(dangerous)");
    expect(writeCmd).not.toContain("`shell`");
  });

  it("logs with council-review prefix", async () => {
    mockExec
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(SAMPLE_FINDINGS_JSON));
    const logSpy = vi.spyOn(console, "log");

    const step = createCouncilReviewStep();
    const ctx = makeCtx();
    await step.execute(ctx);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[blueprint] council-review:"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("task=test-task-1"));
  });
});
