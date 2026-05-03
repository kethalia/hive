import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCouncilEmitStep } from "@/lib/blueprint/steps/council-emit";
import type { BlueprintContext } from "@/lib/blueprint/types";

/**
 * Tests for council-emit — R033 enforcement gate.
 *
 * council-emit does pure JSON parsing and validation: no exec calls, no mocks needed.
 */

function makeCtx(councilFindings?: string): BlueprintContext {
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
    councilFindings,
  };
}

const VALID_FINDING = {
  file: "src/index.ts",
  startLine: 10,
  severity: "major",
  issue: "Unhandled promise rejection",
  fix: "Add try/catch or .catch()",
  reasoning: "Could crash the process",
};

const VALID_FINDINGS_JSON = JSON.stringify({ findings: [VALID_FINDING] });

describe("createCouncilEmitStep — R033 validation gate", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  // ── Happy paths ───────────────────────────────────────────────────

  it("valid JSON with correct schema → success, message contains stringified findings", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx(VALID_FINDINGS_JSON);
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    // message must be the JSON-stringified findings array
    const emitted = JSON.parse(result.message) as unknown[];
    expect(Array.isArray(emitted)).toBe(true);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as typeof VALID_FINDING).file).toBe("src/index.ts");
  });

  it("empty findings array { findings: [] } → success with empty array", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    expect(JSON.parse(result.message)).toEqual([]);
  });

  it("multiple valid findings → success, all findings in message", async () => {
    const secondFinding = {
      file: "src/utils.ts",
      startLine: 42,
      severity: "nit",
      issue: "Unused variable",
      fix: "Remove or use the variable",
      reasoning: "Dead code",
    };
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [VALID_FINDING, secondFinding] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
    const emitted = JSON.parse(result.message) as unknown[];
    expect(emitted).toHaveLength(2);
  });

  // ── Invalid JSON ───────────────────────────────────────────────────

  it("non-parseable string → failure with 'Invalid JSON' message", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx("this is not json at all");
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Invalid JSON");
  });

  it("partially valid JSON (truncated) → failure with 'Invalid JSON' message", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx('{ "findings": [{ "file":');
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Invalid JSON");
  });

  it("empty string → failure with 'Invalid JSON' message", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx("");
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("Invalid JSON");
  });

  it("Invalid JSON preview is capped at 200 chars", async () => {
    const longGarbage = "x".repeat(500);
    const step = createCouncilEmitStep();
    const ctx = makeCtx(longGarbage);
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    // message should NOT contain 500 x's (capped at 200)
    expect(result.message.length).toBeLessThan(400);
  });

  // ── Wrong shape JSON ───────────────────────────────────────────────

  it("valid JSON but no 'findings' field → failure with schema validation message", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ data: [] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  it("valid JSON but 'findings' is not an array → failure", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: "not an array" }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  it("valid JSON but 'findings' is null → failure", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: null }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  it("top-level value is a JSON array (not object) → failure", async () => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify([VALID_FINDING]));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  // ── Per-finding field validation ───────────────────────────────────

  it("finding missing 'startLine' → failure", async () => {
    const bad = { ...VALID_FINDING } as Partial<typeof VALID_FINDING>;
    delete bad.startLine;
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
    expect(result.message).toContain("startLine");
  });

  it("finding with non-number startLine → failure", async () => {
    const bad = { ...VALID_FINDING, startLine: "ten" };
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("startLine");
  });

  it("finding with invalid severity → failure", async () => {
    const bad = { ...VALID_FINDING, severity: "blocker" };
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("severity");
  });

  it("finding missing 'file' field → failure", async () => {
    const bad = { ...VALID_FINDING } as Partial<typeof VALID_FINDING>;
    delete bad.file;
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  it("finding missing 'issue' field → failure", async () => {
    const bad = { ...VALID_FINDING } as Partial<typeof VALID_FINDING>;
    delete bad.issue;
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  it("finding missing 'fix' field → failure", async () => {
    const bad = { ...VALID_FINDING } as Partial<typeof VALID_FINDING>;
    delete bad.fix;
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  it("finding missing 'reasoning' field → failure", async () => {
    const bad = { ...VALID_FINDING } as Partial<typeof VALID_FINDING>;
    delete bad.reasoning;
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("schema validation");
  });

  it("second finding invalid, first valid → failure (all-or-nothing)", async () => {
    const bad = { ...VALID_FINDING, startLine: "not-a-number" };
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [VALID_FINDING, bad] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("startLine");
  });

  // ── Logging ────────────────────────────────────────────────────────

  it("logs with council-emit prefix", async () => {
    const logSpy = vi.spyOn(console, "log");

    const step = createCouncilEmitStep();
    const ctx = makeCtx(VALID_FINDINGS_JSON);
    await step.execute(ctx);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[blueprint] council-emit:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("task=test-task-1"));
  });

  // ── All valid severity values ──────────────────────────────────────

  it.each(["critical", "major", "minor", "nit"])("severity '%s' is accepted", async (severity) => {
    const step = createCouncilEmitStep();
    const ctx = makeCtx(JSON.stringify({ findings: [{ ...VALID_FINDING, severity }] }));
    const result = await step.execute(ctx);

    expect(result.status).toBe("success");
  });
});
