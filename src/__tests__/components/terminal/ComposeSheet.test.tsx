// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as React from "react";
import type { KeybindingContextValue, KeybindingEntry } from "@/hooks/useKeybindings";

const { mockUseIsComposeSheet } = vi.hoisted(() => ({
  mockUseIsComposeSheet: vi.fn(() => false),
}));

const { registeredBindings } = vi.hoisted(() => ({
  registeredBindings: new Map<string, KeybindingEntry>(),
}));

let mockCtx: KeybindingContextValue;

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = ({
      className,
      sessionName,
    }: {
      className?: string;
      sessionName: string;
    }) => (
      <div className={className} data-session-name={sessionName} data-testid="interactive-terminal" />
    );
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("session=tmux-1"),
}));

vi.mock("@/hooks/use-compose-sheet", () => ({
  useIsComposeSheet: mockUseIsComposeSheet,
}));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => mockCtx,
}));

vi.mock("@/components/terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ position }: { position: { x: number; y: number } | null }) =>
    position ? <div data-testid="terminal-context-menu" /> : null,
}));

vi.mock("@/components/terminal/ComposePanel", () => ({
  ComposePanel: ({ hideHeader }: { hideHeader?: boolean }) => (
    <div data-hide-header={hideHeader ? "true" : "false"} data-testid="compose-panel" />
  ),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    className,
    orientation,
  }: React.PropsWithChildren<{ className?: string; orientation?: string }>) => (
    <div className={className} data-orientation={orientation} data-testid="resizable-group">
      {children}
    </div>
  ),
  ResizablePanel: ({
    children,
    defaultSize,
    minSize,
    maxSize,
  }: React.PropsWithChildren<{ defaultSize?: number; minSize?: number; maxSize?: number }>) => (
    <div
      data-default-size={defaultSize}
      data-max-size={maxSize}
      data-min-size={minSize}
      data-testid="resizable-panel"
    >
      {children}
    </div>
  ),
  ResizableHandle: ({ withHandle }: { withHandle?: boolean }) => (
    <div data-testid="resizable-handle" data-with-handle={withHandle ? "true" : "false"} />
  ),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    open,
  }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) => (
    <div data-open={open ? "true" : "false"} data-testid="compose-sheet">
      {open ? children : null}
    </div>
  ),
  SheetContent: ({
    children,
    className,
    side,
  }: React.PropsWithChildren<{ className?: string; side?: string }>) => (
    <section className={className} data-side={side} data-testid="compose-sheet-content">
      {children}
    </section>
  ),
  SheetTitle: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <h2 className={className}>{children}</h2>
  ),
}));

import { TerminalClient } from "@/app/(dashboard)/workspaces/[id]/terminal/terminal-client";

function createMockKeybindingsCtx(): KeybindingContextValue {
  return {
    register: vi.fn((entry: KeybindingEntry) => {
      registeredBindings.set(entry.id, entry);
    }),
    unregister: vi.fn((id: string) => {
      registeredBindings.delete(id);
    }),
    getAll: vi.fn(() => Array.from(registeredBindings.values())),
    handleKeyEvent: vi.fn(() => true),
    activeTerminal: null,
    activeSend: null,
    setActiveTerminal: vi.fn(),
  };
}

async function renderTerminalClient(isComposeSheet: boolean) {
  mockUseIsComposeSheet.mockReturnValue(isComposeSheet);
  render(<TerminalClient agentId="agent-1" workspaceId="workspace-1" />);
  await waitFor(() => {
    expect(registeredBindings.get("compose:toggle:fullscreen")).toBeDefined();
  });
}

function toggleCompose() {
  const binding = registeredBindings.get("compose:toggle:fullscreen");
  expect(binding).toBeDefined();

  let result: boolean | undefined;
  act(() => {
    result = binding?.action(null, null);
  });

  expect(result).toBe(false);
}

describe("TerminalClient compose sheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredBindings.clear();
    mockCtx = createMockKeybindingsCtx();
    mockUseIsComposeSheet.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it("preserves the desktop ResizablePanelGroup compose layout", async () => {
    await renderTerminalClient(false);

    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-session-name",
      "tmux-1",
    );
    expect(screen.getByTestId("resizable-group")).toHaveAttribute("data-orientation", "vertical");
    expect(screen.queryByTestId("compose-sheet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();

    toggleCompose();

    const panels = screen.getAllByTestId("resizable-panel");
    expect(panels).toHaveLength(2);
    expect(panels[0]).toHaveAttribute("data-default-size", "75");
    expect(screen.getByTestId("resizable-handle")).toHaveAttribute("data-with-handle", "true");
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "false");
  });

  it("uses a full-height bottom Sheet below the compose breakpoint", async () => {
    await renderTerminalClient(true);

    expect(screen.getByTestId("interactive-terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("resizable-group")).not.toBeInTheDocument();
    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();

    toggleCompose();

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("compose-sheet-content")).toHaveAttribute("data-side", "bottom");
    expect(screen.getByTestId("compose-sheet-content")).toHaveClass("h-[100dvh]", "p-0");
    expect(screen.getByText("Compose command")).toHaveClass("sr-only");
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "true");
  });

  it.each([false, true])("Ctrl/Cmd+` binding toggles compose open and closed when sheet=%s", async (isComposeSheet) => {
    await renderTerminalClient(isComposeSheet);

    toggleCompose();
    expect(screen.getByTestId("compose-panel")).toBeInTheDocument();

    toggleCompose();
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();
  });
});
