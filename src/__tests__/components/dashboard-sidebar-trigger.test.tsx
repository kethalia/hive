// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

let mockPathname = "/settings";

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
    mockPathname = "/settings";
  });

  it("renders on ordinary dashboard routes", () => {
    render(<DashboardSidebarTrigger />);

    expect(screen.getByTestId("dashboard-sidebar-trigger")).toHaveClass("mt-1", "shrink-0");
  });

  it("does not render on task routes that own the page navbar", () => {
    mockPathname = "/tasks/task-1";

    const { container } = render(<DashboardSidebarTrigger />);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not render on templates routes that own the page navbar", () => {
    mockPathname = "/templates/hive";

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

  it("does not render on full-bleed workspace routes", () => {
    mockPathname = "/workspaces/ws-1/terminal/workspace";

    const { container } = render(<DashboardSidebarTrigger />);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not render on single terminal routes", () => {
    mockPathname = "/workspaces/ws-1/terminal";

    const { container } = render(<DashboardSidebarTrigger />);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not render on legacy full-bleed Git workspace routes", () => {
    mockPathname = "/workspaces/ws-1/terminal/git-workspace";

    const { container } = render(<DashboardSidebarTrigger />);

    expect(container).toBeEmptyDOMElement();
  });
});
