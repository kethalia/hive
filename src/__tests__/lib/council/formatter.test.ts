import { describe, expect, it } from "vitest";
import { formatCouncilComment } from "../../../lib/council/formatter.js";
import type { AggregatedFinding, CouncilReport } from "../../../lib/council/types.js";

// Helpers
function consensusItem(
  overrides: Partial<AggregatedFinding> = {},
): AggregatedFinding {
  return {
    file: "src/foo.ts",
    startLine: 10,
    severity: "major",
    issue: "Some issue",
    fix: "Some fix",
    reasoning: "Some reasoning",
    agreementCount: 2,
    isConsensus: true,
    ...overrides,
  };
}

function report(overrides: Partial<CouncilReport> = {}): CouncilReport {
  return {
    outcome: "complete",
    councilSize: 3,
    reviewersCompleted: 3,
    findings: [],
    consensusItems: [],
    postedCommentUrl: null,
    durationMs: 1000,
    timestamp: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("formatCouncilComment", () => {
  it("returns a 'no issues found' message when there are no consensus items", () => {
    const r = report({ consensusItems: [], findings: [] });
    const output = formatCouncilComment(r);
    expect(output).toContain("No consensus issues found");
    expect(output).toContain("3 of 3 reviewers completed");
  });

  it("includes correct severity emoji headers for each present severity", () => {
    const items: AggregatedFinding[] = [
      consensusItem({ severity: "critical" }),
      consensusItem({ severity: "major", startLine: 20 }),
      consensusItem({ severity: "minor", startLine: 30 }),
      consensusItem({ severity: "nit", startLine: 40 }),
    ];
    const output = formatCouncilComment(report({ consensusItems: items, findings: items }));
    expect(output).toContain("🔴 Critical");
    expect(output).toContain("🟠 Major");
    expect(output).toContain("🟡 Minor");
    expect(output).toContain("💬 Nit");
  });

  it("omits severity sections that have no consensus items", () => {
    const items: AggregatedFinding[] = [consensusItem({ severity: "major" })];
    const output = formatCouncilComment(report({ consensusItems: items, findings: items }));
    expect(output).toContain("🟠 Major");
    expect(output).not.toContain("🔴 Critical");
    expect(output).not.toContain("🟡 Minor");
    expect(output).not.toContain("💬 Nit");
  });

  it("includes file:line, issue, fix, and reasoning for each finding", () => {
    const item = consensusItem({
      file: "src/bar.ts",
      startLine: 42,
      issue: "Null dereference",
      fix: "Add null check",
      reasoning: "Variable can be null here",
    });
    const output = formatCouncilComment(report({ consensusItems: [item], findings: [item] }));
    expect(output).toContain("src/bar.ts:42");
    expect(output).toContain("Null dereference");
    expect(output).toContain("Add null check");
    expect(output).toContain("Variable can be null here");
  });

  it("includes correct counts in the footer", () => {
    const items = [
      consensusItem({ startLine: 1 }),
      consensusItem({ startLine: 2 }),
    ];
    // findings has 3 (one non-consensus), consensusItems has 2
    const extraFinding = { ...consensusItem({ startLine: 99 }), isConsensus: false };
    const r = report({
      consensusItems: items,
      findings: [...items, extraFinding],
      reviewersCompleted: 2,
      councilSize: 3,
    });
    const output = formatCouncilComment(r);
    expect(output).toContain("3 total finding(s)");
    expect(output).toContain("2 consensus");
    expect(output).toContain("2 of 3 reviewers completed");
  });

  it("handles a single severity section correctly", () => {
    const item = consensusItem({ severity: "nit" });
    const output = formatCouncilComment(report({ consensusItems: [item], findings: [item] }));
    expect(output).toContain("💬 Nit");
    // Should not include other severity headers
    expect(output).not.toContain("🔴");
    expect(output).not.toContain("🟠");
    expect(output).not.toContain("🟡");
  });

  it("includes the agreement count in the finding header", () => {
    const item = consensusItem({ agreementCount: 3 });
    const output = formatCouncilComment(report({ consensusItems: [item], findings: [item] }));
    expect(output).toContain("agreed by 3 reviewers");
  });
});
