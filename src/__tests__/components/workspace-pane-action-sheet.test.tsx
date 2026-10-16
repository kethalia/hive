// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@use-gesture/react", () => ({ useDrag: () => () => ({}) }));
const mockUseIsMobile = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: mockUseIsMobile }));
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
    const { side, showCloseButton: _showCloseButton, ...sectionProps } = props;
    return (
      <section data-side={side} {...sectionProps}>
        {children}
      </section>
    );
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
  beforeEach(() => mockUseIsMobile.mockReturnValue(true));

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

    const sheet = screen.getByTestId("workspace-pane-action-sheet");
    expect(sheet).toBeInTheDocument();
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(sheet).toHaveAttribute("data-sidebar-gesture-ignore", "true");
    expect(sheet.style.maxHeight).toBe(
      "min(42rem, calc(var(--app-visual-viewport-height) - 2rem))",
    );
    expect(screen.getByRole("group", { name: "Actions for Terminal one" })).toBeInTheDocument();
    expect(document.querySelector("[cmdk-root]")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-pane-action-activate"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("uses a desktop menu with disabled and destructive actions and closes on selection", async () => {
    mockUseIsMobile.mockReturnValue(false);
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const onDisabledSelect = vi.fn();
    render(
      <WorkspacePaneActionSheet
        open
        onOpenChange={onOpenChange}
        label="Terminal one"
        description="projects/hive"
        actions={[
          { id: "activate", label: "Activate pane", icon: "activate", onSelect },
          {
            id: "move-left",
            label: "Move left",
            icon: "move-left",
            disabled: true,
            onSelect: onDisabledSelect,
          },
          { id: "remove", label: "Remove terminal", icon: "remove", destructive: true, onSelect },
        ]}
      />,
    );

    expect(
      await screen.findByRole("menu", { name: "Actions for Terminal one" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-pane-action-sheet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sheet-root")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove terminal" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    const disabledAction = screen.getByRole("menuitem", { name: "Move left" });
    expect(disabledAction).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(disabledAction);
    expect(onDisabledSelect).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: "Activate pane" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes the desktop menu with Escape and returns focus to its anchor", async () => {
    mockUseIsMobile.mockReturnValue(false);
    function Harness() {
      const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>
            More
          </button>
          <WorkspacePaneActionSheet
            open={anchor !== null}
            anchor={anchor}
            onOpenChange={(open) => {
              if (!open) setAnchor(null);
            }}
            label="Terminal one"
            actions={[
              { id: "activate", label: "Activate pane", icon: "activate", onSelect: vi.fn() },
              { id: "logs", label: "Open logs", icon: "logs", onSelect: vi.fn() },
            ]}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Activate pane" })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Open logs" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("preserves terminal focus selected by an action after dismissing and reopening the menu", async () => {
    mockUseIsMobile.mockReturnValue(false);
    function Harness() {
      const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
      const terminalRef = React.useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <button type="button" onClick={(event) => setAnchor(event.currentTarget)}>
            More
          </button>
          <textarea ref={terminalRef} aria-label="Terminal input" />
          <WorkspacePaneActionSheet
            open={anchor !== null}
            anchor={anchor}
            onOpenChange={(open) => {
              if (!open) setAnchor(null);
            }}
            label="Terminal one"
            actions={[
              {
                id: "activate",
                label: "Activate pane",
                icon: "activate",
                onSelect: () => terminalRef.current?.focus(),
              },
            ]}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Activate pane" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    const terminalInput = screen.getByRole("textbox", { name: "Terminal input" });
    expect(terminalInput).toHaveFocus();

    fireEvent.click(trigger);
    await screen.findByRole("menu");
    fireEvent.pointerDown(terminalInput, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(terminalInput, { button: 0 });
    act(() => terminalInput.focus());
    fireEvent.mouseUp(terminalInput, { button: 0 });
    fireEvent.click(terminalInput);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(terminalInput).toHaveFocus();
  });
});
