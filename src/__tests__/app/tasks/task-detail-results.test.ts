// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDuration, outcomeVariant } from "@/lib/helpers/format";
import type { VerificationReport } from "@/lib/verification/types";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", props, children),
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: vi.fn(() => ({ execute: vi.fn() })),
}));

// ── Import component under test ──────────────────────────────────

import { VerificationReportCard } from "@/app/(dashboard)/tasks/[id]/verification-report-card";

// ── Fixtures ──────────────────────────────────────────────────────

function makeReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    strategy: "test-suite",
    outcome: "pass",
    logs: "Running tests...\n✓ 5 passed\n✗ 0 failed",
    durationMs: 12000,
    timestamp: "2026-03-19T10:30:00Z",
    ...overrides,
  };
}

// ── Helper tests ──────────────────────────────────────────────────

describe("outcomeVariant mapping", () => {
  it("maps pass to default (green badge)", () => {
    expect(outcomeVariant.pass).toBe("default");
  });

  it("maps fail to destructive", () => {
    expect(outcomeVariant.fail).toBe("destructive");
  });

  it("maps inconclusive to secondary", () => {
    expect(outcomeVariant.inconclusive).toBe("secondary");
  });
});

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(12000)).toBe("12s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(150000)).toBe("2m 30s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120000)).toBe("2m");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats sub-second as 0s", () => {
    expect(formatDuration(500)).toBe("0s");
  });
});

// ── Component rendering tests ─────────────────────────────────────

describe("VerificationReportCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders strategy badge text", () => {
    render(React.createElement(VerificationReportCard, { report: makeReport() }));
    const badge = screen.getByTestId("strategy-badge");
    expect(badge.textContent).toContain("test-suite");
  });

  it("renders pass outcome with default variant", () => {
    render(
      React.createElement(VerificationReportCard, { report: makeReport({ outcome: "pass" }) }),
    );
    const badge = screen.getByTestId("outcome-badge");
    expect(badge.textContent).toBe("pass");
  });

  it("renders fail outcome badge", () => {
    render(
      React.createElement(VerificationReportCard, { report: makeReport({ outcome: "fail" }) }),
    );
    const badge = screen.getByTestId("outcome-badge");
    expect(badge.textContent).toBe("fail");
  });

  it("renders inconclusive outcome badge", () => {
    render(
      React.createElement(VerificationReportCard, {
        report: makeReport({ outcome: "inconclusive" }),
      }),
    );
    const badge = screen.getByTestId("outcome-badge");
    expect(badge.textContent).toBe("inconclusive");
  });

  it("renders duration formatted correctly", () => {
    render(
      React.createElement(VerificationReportCard, { report: makeReport({ durationMs: 12000 }) }),
    );
    const duration = screen.getByTestId("duration");
    expect(duration.textContent).toContain("12s");
  });

  it("renders logs collapsed by default", () => {
    render(React.createElement(VerificationReportCard, { report: makeReport() }));
    // Logs toggle button should exist
    const toggle = screen.getByTestId("logs-toggle");
    expect(toggle.textContent).toContain("Show logs");
    // Logs content should not be visible
    expect(screen.queryByTestId("logs-content")).toBeNull();
  });

  it("expands logs when toggle is clicked", () => {
    render(React.createElement(VerificationReportCard, { report: makeReport() }));
    const toggle = screen.getByTestId("logs-toggle");
    fireEvent.click(toggle);
    const content = screen.getByTestId("logs-content");
    expect(content.textContent).toContain("Running tests...");
  });

  it("renders different strategy values", () => {
    render(
      React.createElement(VerificationReportCard, { report: makeReport({ strategy: "web-app" }) }),
    );
    const badge = screen.getByTestId("strategy-badge");
    expect(badge.textContent).toContain("web-app");
  });
});
