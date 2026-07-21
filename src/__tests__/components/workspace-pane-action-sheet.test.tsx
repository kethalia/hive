// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@use-gesture/react", () => ({ useDrag: () => () => ({}) }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));
vi.mock("@/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => false,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetContent: ({
    children,
    ...props
  }: React.ComponentProps<"section"> & { side?: string; showCloseButton?: boolean }) => {
    const { side: _side, showCloseButton: _showCloseButton, ...sectionProps } = props;
    return <section {...sectionProps}>{children}</section>;
  },
  SheetDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  SheetHeader: ({ children, ...props }: React.ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  SheetTitle: ({ children, ...props }: React.ComponentProps<"h2">) => (
    <h2 {...props}>{children}</h2>
  ),
}));

import { WorkspacePaneActionSheet } from "@/components/workspaces/WorkspacePaneActionSheet";

describe("WorkspacePaneActionSheet", () => {
  afterEach(cleanup);

  it("renders actions directly in the drawer and closes after selection", () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <WorkspacePaneActionSheet
        open
        onOpenChange={onOpenChange}
        label="Terminal one"
        description="projects/hive"
        actions={[
          {
            id: "activate",
            label: "Activate pane",
            icon: "activate",
            onSelect,
          },
        ]}
      />,
    );

    expect(screen.getByTestId("workspace-pane-action-sheet")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Actions for Terminal one" })).toBeInTheDocument();
    expect(document.querySelector("[cmdk-root]")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-pane-action-activate"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
