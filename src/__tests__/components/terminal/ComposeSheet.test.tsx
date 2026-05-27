// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as React from "react";
import type { KeybindingContextValue, KeybindingEntry } from "@/hooks/useKeybindings";

const { navigationState } = vi.hoisted(() => {
  const router = { replace: vi.fn() };
  return {
    navigationState: {
      search: "session=tmux-1",
      replace: router.replace,
      router,
    },
  };
});

const { mockGetWorkspaceSessionsAction, mockCreateSessionAction } = vi.hoisted(() => ({
  mockGetWorkspaceSessionsAction: vi.fn(),
  mockCreateSessionAction: vi.fn(),
}));

const { mockUseIsComposeSheet } = vi.hoisted(() => ({
  mockUseIsComposeSheet: vi.fn(() => false),
}));

const { mockUseFabKeyboardOffset } = vi.hoisted(() => ({
  mockUseFabKeyboardOffset: vi.fn(() => ({ liftPx: 0 })),
}));

const { registeredBindings } = vi.hoisted(() => ({
  registeredBindings: new Map<string, KeybindingEntry>(),
}));

let mockCtx: KeybindingContextValue;

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = ({ className, sessionName }: { className?: string; sessionName: string }) => (
      <div
        className={className}
        data-session-name={sessionName}
        data-testid="interactive-terminal"
      />
    );
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigationState.router,
  useSearchParams: () => new URLSearchParams(navigationState.search),
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: mockCreateSessionAction,
  getWorkspaceSessionsAction: mockGetWorkspaceSessionsAction,
}));

vi.mock("@/hooks/use-compose-sheet", () => ({
  useIsComposeSheet: mockUseIsComposeSheet,
}));

vi.mock("@/hooks/useFabKeyboardOffset", () => ({
  useFabKeyboardOffset: mockUseFabKeyboardOffset,
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

vi.mock("@/components/terminal/HapticFloatingActionButton", () => ({
  HapticFloatingActionButton: () => <div data-testid="terminal-fab" />,
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
    ...props
  }: React.PropsWithChildren<
    React.HTMLAttributes<HTMLElement> & { className?: string; side?: string }
  >) => (
    <section className={className} data-side={side} data-testid="compose-sheet-content" {...props}>
      {children}
    </section>
  ),
  SheetTitle: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <h2 className={className}>{children}</h2>
  ),
}));

import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
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
    navigationState.search = "session=tmux-1";
    navigationState.replace.mockClear();
    mockGetWorkspaceSessionsAction.mockReset();
    mockCreateSessionAction.mockReset();
    window.localStorage.clear();
    mockUseIsComposeSheet.mockReturnValue(false);
    mockUseFabKeyboardOffset.mockReset();
    mockUseFabKeyboardOffset.mockReturnValue({ liftPx: 0 });
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
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveStyle({
      height: "calc(100dvh - var(--safe-area-inset-top) - 3.5rem - 0px)",
    });
    expect(screen.getByTestId("terminal-fab")).toBeInTheDocument();
    expect(screen.queryByTestId("resizable-group")).not.toBeInTheDocument();
    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();

    toggleCompose();

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("compose-sheet-content")).toHaveAttribute("data-side", "bottom");
    expect(screen.getByTestId("compose-sheet-content")).toHaveClass(
      "h-[100dvh]",
      "max-h-[100dvh]",
      "p-0",
      "pt-safe",
    );
    expect(screen.getByTestId("compose-sheet-content")).toHaveStyle({
      paddingBottom: "calc(var(--safe-area-inset-bottom) + 0px)",
    });
    expect(screen.getByText("Compose command")).toHaveClass("sr-only");
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "true");
  });

  it("opens the mobile compose Sheet from the global FAB compose event", async () => {
    await renderTerminalClient(true);

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "false");

    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_OPEN_EVENT));
    });

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "true");
  });

  it("keeps the mobile terminal controls and compose sheet above the visual viewport keyboard", async () => {
    mockUseFabKeyboardOffset.mockReturnValue({ liftPx: 280 });
    await renderTerminalClient(true);

    expect(screen.getByTestId("terminal-mobile-shell")).toHaveStyle({
      height: "calc(100dvh - var(--safe-area-inset-top) - 3.5rem - 280px)",
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_OPEN_EVENT));
    });

    expect(screen.getByTestId("compose-sheet-content")).toHaveStyle({
      paddingBottom: "calc(var(--safe-area-inset-bottom) + 280px)",
    });
  });

  it("dismisses the mobile compose Sheet when its handle is dragged downward", async () => {
    await renderTerminalClient(true);

    toggleCompose();
    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");

    const handle = screen.getByRole("button", { name: "Dismiss compose panel" });
    expect(handle).toHaveClass("h-11", "w-20", "touch-none");
    fireEvent.pointerDown(handle, { clientY: 24, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(handle, { clientY: 144, pointerId: 1, pointerType: "touch" });

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();
  });

  it("selects the last existing session when the terminal route opens without a session query", async () => {
    navigationState.search = "";
    window.localStorage.setItem("terminal:last-session:workspace-1", "old-session");
    mockGetWorkspaceSessionsAction.mockResolvedValueOnce({
      data: [
        { name: "main", created: 1, windows: 1 },
        { name: "old-session", created: 2, windows: 1 },
      ],
    });

    await renderTerminalClient(true);

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith(
        "/workspaces/workspace-1/terminal?session=old-session",
      );
    });
    expect(mockCreateSessionAction).not.toHaveBeenCalled();
  });

  it("creates one session when the no-session terminal route has a confirmed empty session list", async () => {
    navigationState.search = "";
    mockGetWorkspaceSessionsAction.mockResolvedValueOnce({ data: [] });
    mockCreateSessionAction.mockResolvedValueOnce({ data: { name: "session-new" } });

    await renderTerminalClient(true);

    await waitFor(() => {
      expect(mockCreateSessionAction).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
    });
    expect(navigationState.replace).toHaveBeenCalledWith(
      "/workspaces/workspace-1/terminal?session=session-new",
    );
  });

  it("shows retry UI without creating a phantom session when session loading fails", async () => {
    navigationState.search = "";
    mockGetWorkspaceSessionsAction.mockResolvedValueOnce({
      serverError:
        "Failed to list tmux sessions (exit 1): no diagnostics returned by workspace command",
    });

    await renderTerminalClient(true);

    expect(await screen.findByText("Could not load terminal sessions")).toBeInTheDocument();
    expect(screen.getByText(/no diagnostics returned by workspace command/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveClass("min-h-11");
    expect(mockCreateSessionAction).not.toHaveBeenCalled();
    expect(navigationState.replace).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("Ctrl/Cmd+` binding toggles compose open and closed when sheet=%s", async (isComposeSheet) => {
    await renderTerminalClient(isComposeSheet);

    toggleCompose();
    expect(screen.getByTestId("compose-panel")).toBeInTheDocument();

    toggleCompose();
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();
  });
});
