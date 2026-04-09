import { describe, expect, it } from "vitest";
import { aggregateFindings } from "../../../lib/council/aggregator.js";
import type { ReviewerFinding } from "../../../lib/council/types.js";

// Helpers
function finding(
  file: string,
  startLine: number,
  overrides: Partial<ReviewerFinding> = {},
): ReviewerFinding {
  return {
    file,
    startLine,
    severity: "major",
    issue: "Test issue",
    fix: "Test fix",
    reasoning: "Test reasoning",
    ...overrides,
  };
}

describe("aggregateFindings", () => {
  it("returns empty findings when given no reviewers", () => {
    const result = aggregateFindings([], 3);
    expect(result.findings).toHaveLength(0);
    expect(result.consensusItems).toHaveLength(0);
  });

  it("returns empty findings when all reviewers returned empty arrays", () => {
    const result = aggregateFindings([[], [], []], 3);
    expect(result.findings).toHaveLength(0);
    expect(result.consensusItems).toHaveLength(0);
  });

  it("sets agreementCount=2 and isConsensus=true when 2 of 3 reviewers flag the same file+line", () => {
    const f = finding("src/foo.ts", 10);
    const result = aggregateFindings([[f], [f], [finding("src/bar.ts", 20)]], 3);

    const match = result.findings.find((x) => x.file === "src/foo.ts" && x.startLine === 10);
    expect(match).toBeDefined();
    expect(match!.agreementCount).toBe(2);
    expect(match!.isConsensus).toBe(true);
  });

  it("sets agreementCount=1 and isConsensus=false when only 1 reviewer flags a line", () => {
    const result = aggregateFindings(
      [[finding("src/unique.ts", 5)], [finding("src/other.ts", 10)], []],
      3,
    );

    const match = result.findings.find((x) => x.file === "src/unique.ts");
    expect(match).toBeDefined();
    expect(match!.agreementCount).toBe(1);
    expect(match!.isConsensus).toBe(false);
  });

  it("preserves severity from the first occurrence when multiple reviewers flag same line", () => {
    const first = finding("src/a.ts", 1, { severity: "critical" });
    const second = finding("src/a.ts", 1, { severity: "minor" }); // different reviewer, different severity
    const result = aggregateFindings([[first], [second]], 2);

    const match = result.findings[0];
    expect(match.severity).toBe("critical");
  });

  it("identifies multiple consensus items across different files", () => {
    const f1 = finding("src/a.ts", 1);
    const f2 = finding("src/b.ts", 99);
    const result = aggregateFindings([[f1, f2], [f1, f2], []], 3);

    expect(result.consensusItems).toHaveLength(2);
    expect(result.consensusItems.every((x) => x.isConsensus)).toBe(true);
  });

  it("sets agreementCount equal to councilSize when all reviewers flag the same line", () => {
    const f = finding("src/x.ts", 7);
    const result = aggregateFindings([[f], [f], [f]], 3);

    const match = result.findings[0];
    expect(match.agreementCount).toBe(3);
    expect(match.isConsensus).toBe(true);
  });

  it("handles a single reviewer (no consensus possible)", () => {
    const result = aggregateFindings([[finding("src/only.ts", 1)]], 1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].isConsensus).toBe(false);
    expect(result.consensusItems).toHaveLength(0);
  });
});
