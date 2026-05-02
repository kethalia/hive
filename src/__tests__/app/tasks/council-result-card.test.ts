// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedFinding, CouncilReport } from "@/lib/council/types";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => React.createElement("a", { href, ...props }, children),
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: vi.fn(() => ({ execute: vi.fn() })),
}));

// ── Import component under test ────────────────────────────────────
import { CouncilResultCard } from "@/app/(dashboard)/tasks/[id]/council-result-card";

// ── Fixtures ───────────────────────────────────────────────────────

function makeAggregatedFinding(overrides: Partial<AggregatedFinding> = {}): AggregatedFinding {
  return {
    file: "src/foo.ts",
    startLine: 10,
    severity: "major",
    issue: "Unused variable detected",
    fix: "Remove the unused variable",
    reasoning: "It clutters the code",
    agreementCount: 2,
    isConsensus: true,
    ...overrides,
  };
}

function makeCouncilReport(overrides: Partial<CouncilReport> = {}): CouncilReport {
  return {
    outcome: "complete",
    councilSize: 3,
    reviewersCompleted: 3,
    findings: [
      makeAggregatedFinding({ severity: "critical", agreementCount: 3 }),
      makeAggregatedFinding({ severity: "major", agreementCount: 2 }),
      makeAggregatedFinding({ severity: "minor", agreementCount: 1, isConsensus: false }),
    ],
    consensusItems: [makeAggregatedFinding({ severity: "critical", agreementCount: 3 })],
    postedCommentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
    durationMs: 45000,
    timestamp: "2026-04-01T12:00:00Z",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("CouncilResultCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders outcome badge with correct text", () => {
    render(React.createElement(CouncilResultCard, { report: makeCouncilReport() }));
    const badge = screen.getByTestId("council-outcome-badge");
    expect(badge.textContent).toBe("complete");
  });

  it("renders partial outcome badge", () => {
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ outcome: "partial" }),
      }),
    );
    const badge = screen.getByTestId("council-outcome-badge");
    expect(badge.textContent).toBe("partial");
  });

  it("renders inconclusive outcome badge", () => {
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ outcome: "inconclusive" }),
      }),
    );
    const badge = screen.getByTestId("council-outcome-badge");
    expect(badge.textContent).toBe("inconclusive");
  });

  it("renders severity count badges only for severities with findings > 0", () => {
    const report = makeCouncilReport({
      findings: [
        makeAggregatedFinding({ severity: "critical" }),
        makeAggregatedFinding({ severity: "critical" }),
        makeAggregatedFinding({ severity: "major" }),
        // no minor or nit findings
      ],
    });
    render(React.createElement(CouncilResultCard, { report }));

    // Critical and major should be present
    expect(screen.getByTestId("severity-critical")).toBeTruthy();
    expect(screen.getByTestId("severity-major")).toBeTruthy();
    // Minor and nit should NOT be present
    expect(screen.queryByTestId("severity-minor")).toBeNull();
    expect(screen.queryByTestId("severity-nit")).toBeNull();
  });

  it("renders severity badge text with count", () => {
    const report = makeCouncilReport({
      findings: [
        makeAggregatedFinding({ severity: "critical" }),
        makeAggregatedFinding({ severity: "critical" }),
      ],
    });
    render(React.createElement(CouncilResultCard, { report }));
    const badge = screen.getByTestId("severity-critical");
    expect(badge.textContent).toContain("2");
    expect(badge.textContent).toContain("Critical");
  });

  it("renders consensus items with file:line and issue text", () => {
    const report = makeCouncilReport({
      consensusItems: [
        makeAggregatedFinding({
          file: "src/bar.ts",
          startLine: 42,
          issue: "Memory leak in effect",
        }),
      ],
    });
    render(React.createElement(CouncilResultCard, { report }));
    const item = screen.getByTestId("consensus-item");
    expect(item.textContent).toContain("src/bar.ts:42");
    expect(item.textContent).toContain("Memory leak in effect");
  });

  it("shows PR comment link when postedCommentUrl is set", () => {
    const url = "https://github.com/org/repo/pull/1#issuecomment-1";
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ postedCommentUrl: url }),
      }),
    );
    const link = screen.getByTestId("pr-comment-link");
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe(url);
  });

  it("hides PR comment link when postedCommentUrl is null", () => {
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ postedCommentUrl: null }),
      }),
    );
    expect(screen.queryByTestId("pr-comment-link")).toBeNull();
  });

  it("shows reviewer completion count", () => {
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ reviewersCompleted: 2, councilSize: 3 }),
      }),
    );
    const stat = screen.getByTestId("reviewer-count");
    expect(stat.textContent).toContain("2/3 reviewers completed");
  });

  it("handles empty findings gracefully — no severity badges shown", () => {
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ findings: [], consensusItems: [] }),
      }),
    );
    expect(screen.queryByTestId("severity-critical")).toBeNull();
    expect(screen.queryByTestId("severity-major")).toBeNull();
    expect(screen.queryByTestId("severity-minor")).toBeNull();
    expect(screen.queryByTestId("severity-nit")).toBeNull();
  });

  it("collapses consensus items beyond 3 with expand button", () => {
    const manyItems = Array.from({ length: 5 }, (_, i) =>
      makeAggregatedFinding({ issue: `Issue ${i}`, startLine: i + 1 }),
    );
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ consensusItems: manyItems }),
      }),
    );
    // Only first 3 visible
    const items = screen.getAllByTestId("consensus-item");
    expect(items).toHaveLength(3);
    // Expand button present
    const btn = screen.getByText(/Show 2 more/i);
    expect(btn).toBeTruthy();
  });

  it("expands consensus items when show more is clicked", () => {
    const manyItems = Array.from({ length: 5 }, (_, i) =>
      makeAggregatedFinding({ issue: `Issue ${i}`, startLine: i + 1 }),
    );
    render(
      React.createElement(CouncilResultCard, {
        report: makeCouncilReport({ consensusItems: manyItems }),
      }),
    );
    const btn = screen.getByText(/Show 2 more/i);
    fireEvent.click(btn);
    const items = screen.getAllByTestId("consensus-item");
    expect(items).toHaveLength(5);
  });
});
