// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardPageShell } from "@/components/dashboard-page-shell";

describe("DashboardPageShell", () => {
  it("provides responsive page gutters while allowing the page header to stay full width", () => {
    render(
      <DashboardPageShell data-testid="page-shell">
        <header data-dashboard-page-nav="">Header</header>
        <div>Content</div>
      </DashboardPageShell>,
    );

    const shell = screen.getByTestId("page-shell");
    expect(shell).toHaveClass("px-3", "sm:px-4", "lg:px-6", "pb-safe");
    expect(shell.className).toContain("[&>[data-dashboard-page-nav]]:-mx-3");
    expect(shell.className).toContain("sm:[&>[data-dashboard-page-nav]]:-mx-4");
    expect(shell.className).toContain("lg:[&>[data-dashboard-page-nav]]:-mx-6");
  });
});
