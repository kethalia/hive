// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const { mockUseFavoriteWindowNavigation } = vi.hoisted(() => ({
  mockUseFavoriteWindowNavigation: vi.fn(),
}));

const { mockUseVisualViewportKeyboardOffset } = vi.hoisted(() => ({
  mockUseVisualViewportKeyboardOffset: vi.fn(() => ({
    liftPx: 0,
    isKeyboardVisible: false,
    visualViewportHeightPx: 0,
    visualViewportOffsetTopPx: 0,
  })),
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
      layoutSignal,
      mobileInputMode,
      pinToBottomOnResize,
      sessionName,
    }: {
      className?: string;
      layoutSignal?: unknown;
      mobileInputMode?: boolean;
      pinToBottomOnResize?: boolean;
      sessionName: string;
    }) => (
      <div
        className={className}
        data-layout-signal={String(layoutSignal ?? "")}
        data-mobile-input-mode={mobileInputMode ? "true" : "false"}
        data-pin-to-bottom-on-resize={pinToBottomOnResize ? "true" : "false"}
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

vi.mock("@/hooks/useFavoriteWindowNavigation", () => ({
  useFavoriteWindowNavigation: mockUseFavoriteWindowNavigation,
}));

vi.mock("@/hooks/useVisualViewportKeyboardOffset", () => ({
  useVisualViewportKeyboardOffset: mockUseVisualViewportKeyboardOffset,
}));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => mockCtx,
}));

vi.mock("@/components/terminal/ComposePanel", () => ({
  ComposePanel: ({ hideHeader }: { hideHeader?: boolean }) => (
    <div data-hide-header={hideHeader ? "true" : "false"} data-testid="compose-panel" />
  ),
}));

vi.mock("@/components/terminal/CommandPalette", () => ({
  CommandPalette: ({ open }: { open: boolean }) => (
    <div data-open={open ? "true" : "false"} data-testid="terminal-command-palette" />
  ),
}));

vi.mock("@/components/terminal/MobileTerminalControls", () => ({
  MobileTerminalControls: ({ isKeyboardVisible }: { isKeyboardVisible?: boolean }) => (
    <button
      type="button"
      data-keyboard-visible={isKeyboardVisible ? "true" : "false"}
      data-testid="terminal-mobile-controls"
      onClick={() => window.dispatchEvent(new CustomEvent("hive:terminal-compose-open"))}
    >
      Open compose from controls
    </button>
  ),
}));

vi.mock("@/components/terminal/MobileTerminalDiagnosticsOverlay", () => ({
  MobileTerminalDiagnosticsOverlay: ({ enabled }: { enabled: boolean }) =>
    enabled ? <div data-testid="mobile-terminal-diagnostics-overlay" /> : null,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-testid="workspace-sidebar-trigger">
      Toggle Sidebar
    </button>
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

import { TerminalClient } from "@/app/(dashboard)/workspaces/[id]/terminal/terminal-client";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";

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
    mockUseFavoriteWindowNavigation.mockReturnValue({
      sessions: [],
      current: null,
      previous: null,
      next: null,
      canGoPrevious: false,
      canGoNext: false,
      loading: false,
      error: null,
      reload: vi.fn(),
      select: vi.fn(),
    });
    mockUseVisualViewportKeyboardOffset.mockReset();
    mockUseVisualViewportKeyboardOffset.mockReturnValue({
      liftPx: 0,
      isKeyboardVisible: false,
      visualViewportHeightPx: 0,
      visualViewportOffsetTopPx: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("uses a fixed-height collapsible desktop compose panel", async () => {
    await renderTerminalClient(false);

    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-session-name",
      "tmux-1",
    );
    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-mobile-input-mode",
      "false",
    );
    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "false",
    );
    expect(screen.queryByTestId("resizable-group")).not.toBeInTheDocument();
    expect(screen.queryByTestId("compose-sheet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-desktop-shell")).toHaveAttribute(
      "data-terminal-shell",
      "true",
    );
    expect(mockUseFavoriteWindowNavigation).toHaveBeenCalledWith("workspace-1");
    expect(mockGetWorkspaceSessionsAction).not.toHaveBeenCalled();
    expect(mockCreateSessionAction).not.toHaveBeenCalled();
    expect(document.body.style.position).not.toBe("fixed");
    expect(document.documentElement.style.overflow).not.toBe("hidden");

    toggleCompose();

    expect(screen.queryByTestId("resizable-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("resizable-handle")).not.toBeInTheDocument();
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "false");
    expect(screen.getByTestId("compose-panel").parentElement).toHaveClass(
      "flex",
      "h-full",
      "min-h-0",
      "overflow-hidden",
      "rounded-lg",
      "border",
      "border-primary",
      "bg-black",
      "shadow-sm",
      "ring-1",
      "ring-primary",
    );
    expect(screen.getByTestId("compose-panel").parentElement?.parentElement).toHaveClass(
      "h-72",
      "min-h-56",
      "shrink-0",
      "p-1",
      "pt-0",
    );
  });

  it("uses a full-height bottom Sheet below the compose breakpoint", async () => {
    await renderTerminalClient(true);

    expect(screen.getByTestId("interactive-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-mobile-input-mode",
      "true",
    );
    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "true",
    );
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveClass(
      "terminal-mobile-shell",
      "fixed",
      "overflow-hidden",
      "overscroll-none",
      "top-[var(--safe-area-inset-top)]",
    );
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveStyle({
      height: "var(--app-visual-viewport-height)",
      maxHeight: "var(--app-visual-viewport-height)",
      top: "var(--app-visual-viewport-offset-top)",
    });
    expect(screen.getByTestId("terminal-mobile-shell")).not.toHaveClass(
      "-mb-[calc(var(--safe-area-inset-bottom)+1.5rem)]",
    );
    expect(screen.getByTestId("terminal-mobile-shell").firstElementChild).toHaveClass(
      "flex",
      "h-full",
      "min-h-0",
      "flex-col",
      "overflow-hidden",
      "overscroll-none",
    );
    expect(screen.queryByRole("heading", { name: "tmux-1" })).not.toBeInTheDocument();
    expect(screen.getByTestId("single-terminal-frame")).toHaveClass("h-full", "rounded-lg");
    expect(document.querySelector("[data-terminal-surface='true']")).toHaveClass("h-full");
    expect(screen.getByTestId("terminal-mobile-controls")).toBeInTheDocument();
    expect(screen.queryByTestId("resizable-group")).not.toBeInTheDocument();
    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("compose-panel")).not.toBeInTheDocument();

    toggleCompose();

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("compose-sheet-content")).toHaveAttribute("data-side", "bottom");
    expect(screen.getByTestId("compose-sheet-content")).toHaveClass(
      "h-[var(--app-viewport-height)]",
      "max-h-[var(--app-viewport-height)]",
      "p-0",
      "pt-safe",
    );
    expect(screen.getByTestId("compose-sheet-content")).toHaveStyle({
      bottom: "0px",
      height: "var(--app-visual-viewport-height)",
      maxHeight: "var(--app-visual-viewport-height)",
      paddingBottom: "var(--safe-area-inset-bottom)",
    });
    expect(screen.getByText("Compose command")).toHaveClass("sr-only");
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "true");
  });

  it("keeps diagnostics overlay hidden unless debugViewport query is enabled", async () => {
    await renderTerminalClient(true);

    expect(screen.queryByTestId("mobile-terminal-diagnostics-overlay")).not.toBeInTheDocument();
  });

  it("enables diagnostics overlay with stable terminal telemetry selectors in mobile debug mode", async () => {
    navigationState.search = "session=tmux-1&debugViewport=1";

    await renderTerminalClient(true);

    expect(screen.getByTestId("mobile-terminal-diagnostics-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveAttribute(
      "data-terminal-shell",
      "true",
    );
    expect(document.querySelector("[data-terminal-surface='true']")).toBeInTheDocument();
  });

  it("enables diagnostics overlay with a stable terminal shell selector in desktop debug mode", async () => {
    navigationState.search = "session=tmux-1&debugViewport=1";

    await renderTerminalClient(false);

    expect(screen.getByTestId("mobile-terminal-diagnostics-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-desktop-shell")).toHaveAttribute(
      "data-terminal-shell",
      "true",
    );
  });

  it("locks document scrolling while the mobile terminal owns the viewport", async () => {
    await renderTerminalClient(true);

    expect(document.documentElement).toHaveStyle({
      height: "var(--app-viewport-height)",
      overflow: "hidden",
      overscrollBehaviorY: "none",
    });
    expect(document.body).toHaveStyle({
      height: "var(--app-viewport-height)",
      maxHeight: "var(--app-viewport-height)",
      overflow: "hidden",
      overscrollBehaviorY: "none",
      position: "fixed",
      right: "0px",
      top: "0px",
      width: "100%",
    });

    const outsideScroll = new Event("touchmove", { bubbles: true, cancelable: true });
    document.dispatchEvent(outsideScroll);
    expect(outsideScroll.defaultPrevented).toBe(true);
    const outsideWheel = new Event("wheel", { bubbles: true, cancelable: true });
    document.dispatchEvent(outsideWheel);
    expect(outsideWheel.defaultPrevented).toBe(true);

    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const terminalRow = document.createElement("div");
    terminalRow.className = "xterm-rows";
    terminal.appendChild(terminalRow);
    screen.getByTestId("terminal-mobile-shell").appendChild(terminal);
    const terminalScroll = new Event("touchmove", { bubbles: true, cancelable: true });
    terminalRow.dispatchEvent(terminalScroll);
    expect(terminalScroll.defaultPrevented).toBe(true);
    terminal.remove();
  });

  it("opens the mobile compose Sheet from the mobile controls action", async () => {
    await renderTerminalClient(true);

    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-mobile-input-mode",
      "true",
    );
    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "false");

    fireEvent.click(screen.getByTestId("terminal-mobile-controls"));

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("compose-sheet-content")).toHaveAttribute("data-side", "bottom");
    expect(screen.getByTestId("compose-sheet-content")).toHaveStyle({
      bottom: "0px",
      height: "var(--app-visual-viewport-height)",
      maxHeight: "var(--app-visual-viewport-height)",
      paddingBottom: "var(--safe-area-inset-bottom)",
    });
    expect(screen.getByTestId("terminal-mobile-controls")).toBeInTheDocument();
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "true");
  });

  it("opens the mobile compose Sheet from the global terminal compose event", async () => {
    await renderTerminalClient(true);

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "false");

    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_OPEN_EVENT));
    });

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("compose-panel")).toHaveAttribute("data-hide-header", "true");
  });

  it("keeps the mobile terminal controls and compose sheet above the visual viewport keyboard", async () => {
    mockUseVisualViewportKeyboardOffset.mockReturnValue({
      liftPx: 0,
      isKeyboardVisible: true,
      visualViewportHeightPx: 500,
      visualViewportOffsetTopPx: 240,
    });
    await renderTerminalClient(true);

    expect(screen.getByTestId("terminal-mobile-shell")).toHaveStyle({
      height: "var(--app-visual-viewport-height)",
      maxHeight: "var(--app-visual-viewport-height)",
      top: "var(--app-visual-viewport-offset-top)",
    });
    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-layout-signal",
      "keyboard:500:240",
    );
    expect(screen.getByTestId("interactive-terminal")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "true",
    );
    expect(document.documentElement).toHaveStyle({
      height: "var(--app-visual-viewport-height)",
      overflow: "hidden",
    });
    expect(document.body).toHaveStyle({
      height: "var(--app-visual-viewport-height)",
      maxHeight: "var(--app-visual-viewport-height)",
      overflow: "hidden",
      top: "0px",
    });
    expect(screen.getByTestId("terminal-mobile-controls")).toHaveAttribute(
      "data-keyboard-visible",
      "true",
    );

    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_OPEN_EVENT));
    });

    expect(screen.getByTestId("compose-sheet-content")).toHaveStyle({
      bottom:
        "calc(var(--app-viewport-height) - var(--app-visual-viewport-height) - var(--app-visual-viewport-offset-top))",
      height: "var(--app-visual-viewport-height)",
      maxHeight: "var(--app-visual-viewport-height)",
      paddingBottom: "var(--safe-area-inset-bottom)",
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

  it("preserves debugViewport while resolving a no-session route", async () => {
    navigationState.search = "debugViewport=1";
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
        "/workspaces/workspace-1/terminal?session=old-session&debugViewport=1",
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
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveAttribute(
      "data-terminal-shell",
      "true",
    );
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveClass(
      "items-center",
      "justify-center",
    );
    expect(document.body).toHaveStyle({
      height: "var(--app-viewport-height)",
      overflow: "hidden",
      position: "fixed",
    });
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
