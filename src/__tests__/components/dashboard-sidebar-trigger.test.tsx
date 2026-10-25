// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

let mockPathname = "/other";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-testid="dashboard-sidebar-trigger">
      Toggle sidebar
    </button>
  ),
}));

import { DashboardSidebarTrigger } from "@/components/dashboard-sidebar-trigger";

describe("DashboardSidebarTrigger", () => {
  afterEach(() => {
    cleanup();
    mockPathname = "/other";
  });

  it("renders on ordinary dashboard routes", () => {
    render(<DashboardSidebarTrigger />);

    expect(screen.getByTestId("dashboard-sidebar-trigger")).toHaveClass("mt-1", "shrink-0");
  });

  it("does not duplicate the settings page navbar trigger", () => {
    mockPathname = "/settings";
    const { container } = render(<DashboardSidebarTrigger />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not duplicate the notifications page navbar trigger", () => {
    mockPathname = "/notifications";
    const { container } = render(<DashboardSidebarTrigger />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not render on templates routes that own the page navbar", () => {
    mockPathname = "/templates/browser-testing";

    const { container } = render(<DashboardSidebarTrigger />);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not render on workspace and terminal status list routes that own the page navbar", () => {
    mockPathname = "/terminal/status";

    const first = render(<DashboardSidebarTrigger />);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    mockPathname = "/workspaces";

    const second = render(<DashboardSidebarTrigger />);
    expect(second.container).toBeEmptyDOMElement();
  });
});
