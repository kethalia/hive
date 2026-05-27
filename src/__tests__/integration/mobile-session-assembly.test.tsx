// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mobileState = vi.hoisted(() => ({ isMobile: true }));
const motionState = vi.hoisted(() => ({ reduced: false }));

const keybindingState = vi.hoisted(() => ({
  activeSend: vi.fn(),
  handleKeyEvent: vi.fn(() => true),
  register: vi.fn(),
  setActiveTerminal: vi.fn(),
  unregister: vi.fn(),
}));

const hapticsState = vi.hoisted(() => ({
  triggerHapticFeedback: vi.fn(() => true),
}));

const dashboardState = vi.hoisted(() => ({
  getTokenStatusAction: vi.fn(),
}));

const workspaceActions = vi.hoisted(() => ({
  createSessionAction: vi.fn(),
  getWorkspaceSessionsAction: vi.fn(),
  killSessionAction: vi.fn(),
  renameSessionAction: vi.fn(),
}));

const fabState = vi.hoisted(() => ({
  capturedOnArmed: undefined as (() => void) | undefined,
  corner: "bottom-right" as const,
  decreaseFontSize: vi.fn(),
  increaseFontSize: vi.fn(),
  isDragging: false,
  isSnapping: false,
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(() => false),
  position: { x: 320, y: 700 },
}));

const terminalState = vi.hoisted(() => ({
  fit: vi.fn(),
  resize: vi.fn(),
  send: vi.fn(),
  terminalInstances: [] as Array<{ rows: number; cols: number; options: { fontSize?: number } }>,
}));

const pinchZoomState = vi.hoisted(() => ({
  bindCallCount: 0,
}));

const gestureState = vi.hoisted(() => ({
  dragConfigs: [] as unknown[],
  dragHandlers: [] as Array<(state: Record<string, unknown>) => void>,
  gestureConfigs: [] as unknown[],
  gestureHandlers: [] as Array<Record<string, (state: Record<string, unknown>) => void>>,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileState.isMobile,
}));

vi.mock("@/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => motionState.reduced,
}));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => ({
    activeSend: keybindingState.activeSend,
    activeTerminal: null,
    getAll: vi.fn(() => []),
    handleKeyEvent: keybindingState.handleKeyEvent,
    register: keybindingState.register,
    setActiveTerminal: keybindingState.setActiveTerminal,
    unregister: keybindingState.unregister,
  }),
}));

vi.mock("@/lib/device/haptics", () => ({
  triggerHapticFeedback: hapticsState.triggerHapticFeedback,
}));

vi.mock("@/lib/auth/actions", () => ({
  getTokenStatusAction: dashboardState.getTokenStatusAction,
}));

vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => <aside data-testid="app-sidebar">Navigation</aside>,
}));

vi.mock("@/components/push-permission-prompt", () => ({
  PushPermissionPrompt: () => <div data-testid="push-permission-prompt" />,
}));

vi.mock("@/components/token-expiry-banner", () => ({
  TokenExpiryBanner: () => <div data-testid="token-expiry-banner" />,
}));

vi.mock("@/components/sidebar-edge-handle", () => ({
  SidebarEdgeHandle: () => null,
}));

vi.mock("@/components/terminal/HelpOverlay", () => ({
  HelpOverlay: () => <div data-testid="help-overlay" />,
}));

vi.mock("@/components/terminal/KeybindingProvider", () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="keybinding-provider">{children}</div>
  ),
}));

vi.mock("@/hooks/useFabKeyboardOffset", () => ({
  useFabKeyboardOffset: () => ({ liftPx: 0 }),
}));

vi.mock("@/hooks/useFabPosition", () => ({
  useFabPosition: (opts?: { onArmed?: () => void }) => {
    fabState.capturedOnArmed = opts?.onArmed;
    return {
      corner: fabState.corner,
      dragDist: { current: 0 },
      isArmed: false,
      isDragging: fabState.isDragging,
      isSnapping: fabState.isSnapping,
      onPointerCancel: vi.fn(),
      onPointerDown: fabState.onPointerDown,
      onPointerMove: fabState.onPointerMove,
      onPointerUp: fabState.onPointerUp,
      position: fabState.position,
    };
  },
}));

vi.mock("@/hooks/useTerminalFontStep", () => ({
  useTerminalFontStep: () => ({
    canDecrease: true,
    canIncrease: true,
    decrease: fabState.decreaseFontSize,
    increase: fabState.increaseFontSize,
    size: 12,
  }),
}));

vi.mock("@use-gesture/react", () => ({
  useDrag: vi.fn((handler, config) => {
    gestureState.dragHandlers.push(handler);
    gestureState.dragConfigs.push(config);

    let startX = 0;
    let startY = 0;

    return () => ({
      "data-use-drag-bound": "true",
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        startX = event.clientX;
        startY = event.clientY;
        handler({
          active: true,
          cancel: vi.fn(),
          direction: [0, 0],
          event: event.nativeEvent,
          first: true,
          last: false,
          movement: [0, 0],
          velocity: [0, 0],
        });
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        const movementX = event.clientX - startX;
        const movementY = event.clientY - startY;
        handler({
          active: true,
          cancel: vi.fn(),
          direction: [Math.sign(movementX), Math.sign(movementY)],
          event: event.nativeEvent,
          first: false,
          last: false,
          movement: [movementX, movementY],
          velocity: [0, 0],
        });
      },
      onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
        const movementX = event.clientX - startX;
        const movementY = event.clientY - startY;
        handler({
          active: false,
          cancel: vi.fn(),
          direction: [Math.sign(movementX), Math.sign(movementY)],
          event: event.nativeEvent,
          first: false,
          last: true,
          movement: [movementX, movementY],
          velocity: [0, 0],
        });
      },
    });
  }),
  useGesture: vi.fn((handlers, config) => {
    gestureState.gestureHandlers.push(handlers);
    gestureState.gestureConfigs.push(config);

    let startX = 0;
    let startY = 0;

    return () => ({
      "data-use-gesture-bound": "true",
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        startX = event.clientX;
        startY = event.clientY;
        handlers.onDrag?.({
          distance: [0, 0],
          event: event.nativeEvent,
          first: true,
          last: false,
          xy: [event.clientX, event.clientY],
        });
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        handlers.onDrag?.({
          distance: [Math.abs(event.clientX - startX), Math.abs(event.clientY - startY)],
          event: event.nativeEvent,
          first: false,
          last: false,
          xy: [event.clientX, event.clientY],
        });
      },
      onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
        handlers.onDrag?.({
          distance: [Math.abs(event.clientX - startX), Math.abs(event.clientY - startY)],
          event: event.nativeEvent,
          first: false,
          last: true,
          xy: [event.clientX, event.clientY],
        });
      },
    });
  }),
  usePinch: vi.fn(() => () => ({ "data-use-pinch-bound": "true" })),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  ArrowDown: () => <span data-testid="icon-arrow-down" />,
  ArrowLeft: () => <span data-testid="icon-arrow-left" />,
  ArrowRight: () => <span data-testid="icon-arrow-right" />,
  ArrowUp: () => <span data-testid="icon-arrow-up" />,
  ClipboardPaste: () => <span data-testid="icon-paste" />,
  Copy: () => <span data-testid="icon-copy" />,
  CornerDownLeft: () => <span data-testid="icon-enter" />,
  Ellipsis: () => <span data-testid="icon-ellipsis" />,
  Keyboard: () => <span data-testid="icon-keyboard" />,
  MessageSquareText: () => <span data-testid="icon-compose" />,
  Minus: () => <span data-testid="icon-minus" />,
  PanelLeftIcon: () => <span data-testid="icon-panel-left" />,
  Pencil: () => <span data-testid="icon-pencil" />,
  Plus: () => <span data-testid="icon-plus" />,
  SearchIcon: () => <span data-testid="icon-search" />,
  Send: () => <span data-testid="icon-send" />,
  Terminal: () => <span data-testid="icon-terminal" />,
  X: () => <span data-testid="icon-x" />,
  XIcon: () => <span data-testid="icon-x-icon" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    className,
    disabled,
    onClick,
    onDoubleClick,
    title,
    type = "button",
    ...rest
  }: React.PropsWithChildren<{
    className?: string;
    disabled?: boolean;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    onDoubleClick?: React.MouseEventHandler<HTMLButtonElement>;
    title?: string;
    type?: "button" | "submit" | "reset";
    "data-testid"?: string;
  }>) => (
    <button
      className={className}
      data-testid={rest["data-testid"]}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
      type={type}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement> & { "data-testid"?: string }) => (
    <input {...props} data-testid={props["data-testid"]} />
  ),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizableHandle: () => <div data-testid="resizable-handle" />,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/terminal/ComposePanel", () => ({
  ComposePanel: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close compose
    </button>
  ),
}));

vi.mock("@/components/workspaces/KeepAliveWarning", () => ({
  KeepAliveWarning: () => null,
}));

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = ({ sessionName }: { sessionName: string }) => (
      <div data-testid={`terminal-${sessionName}`}>Terminal: {sessionName}</div>
    );
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: (...args: unknown[]) => workspaceActions.createSessionAction(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) =>
    workspaceActions.getWorkspaceSessionsAction(...args),
  killSessionAction: (...args: unknown[]) => workspaceActions.killSessionAction(...args),
  renameSessionAction: (...args: unknown[]) => workspaceActions.renameSessionAction(...args),
}));

vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: vi.fn(),
  pasteToTerminal: vi.fn(),
}));

vi.mock("@/components/ui/command", () => ({
  Command: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className} data-slot="command" data-testid="command">
      {children}
    </div>
  ),
  CommandDialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="command-dialog">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close
        </button>
        {children}
      </div>
    ) : null,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children, heading }: { children: ReactNode; heading?: string }) => (
    <div data-heading={heading}>{children}</div>
  ),
  CommandInput: ({ placeholder }: { placeholder?: string }) => <input placeholder={placeholder} />,
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    value?: string;
  }) => (
    <div cmdk-item="" data-value={value} onClick={onSelect} role="option" tabIndex={-1}>
      {children}
    </div>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/hooks/useTerminalPinchZoom", () => ({
  useTerminalPinchZoom: () => () => {
    pinchZoomState.bindCallCount += 1;
    return { "data-terminal-pinch-zoom": "bound" };
  },
}));

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = terminalState.fit;
  }

  return { FitAddon };
});

vi.mock("@xterm/xterm", () => {
  class Terminal {
    rows = 24;
    cols = 80;
    options: { fontSize?: number };
    attachCustomKeyEventHandler = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    open = vi.fn();
    write = vi.fn();

    constructor(options: { fontSize?: number }) {
      this.options = { ...options };
      terminalState.terminalInstances.push(this);
    }
  }

  return { Terminal };
});

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: () => ({
    connectionState: "disconnected",
    resize: terminalState.resize,
    send: terminalState.send,
  }),
}));

vi.mock("@/lib/runtime-config", () => ({
  getClientRuntimeConfig: () => ({ terminalWsUrl: "ws://terminal.example.test" }),
}));

vi.mock("@/lib/terminal/config", () => ({
  loadTerminalFont: vi.fn(() => Promise.resolve()),
  TERMINAL_FONT_FAMILY: "Test Mono",
  TERMINAL_THEME: {},
}));

import DashboardLayout from "@/app/(dashboard)/layout";
import { AgentStreamPanel } from "@/app/(dashboard)/tasks/[id]/agent-stream-panel";
import { CommandPalette } from "@/components/terminal/CommandPalette";
import { TerminalContextMenu } from "@/components/terminal/TerminalContextMenu";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { InteractiveTerminal } from "@/components/workspaces/InteractiveTerminal";
import { TerminalTabManager } from "@/components/workspaces/TerminalTabManager";
import { LONG_PRESS_MS } from "@/lib/gestures/conventions";

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

type ESListener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 0;
  url: string;

  private listeners: Record<string, ESListener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: ESListener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: ESListener) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((item) => item !== listener);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emitMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

function resetFabState() {
  fabState.capturedOnArmed = undefined;
  fabState.corner = "bottom-right";
  fabState.isDragging = false;
  fabState.isSnapping = false;
  fabState.position = { x: 320, y: 700 };
  fabState.onPointerDown.mockClear();
  fabState.onPointerMove.mockClear();
  fabState.onPointerUp.mockReset();
  fabState.onPointerUp.mockReturnValue(false);
  fabState.increaseFontSize.mockClear();
  fabState.decreaseFontSize.mockClear();
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
}

function latestDragHandler() {
  const handler = gestureState.dragHandlers.at(-1);
  expect(handler).toEqual(expect.any(Function));
  return handler!;
}

async function findSheetContent() {
  await waitFor(() => {
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull();
  });
  const content = document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
  expect(content).not.toBeNull();
  return content!;
}

beforeEach(() => {
  cleanup();
  mobileState.isMobile = true;
  motionState.reduced = false;
  keybindingState.activeSend.mockClear();
  keybindingState.handleKeyEvent.mockClear();
  keybindingState.register.mockClear();
  keybindingState.unregister.mockClear();
  keybindingState.setActiveTerminal.mockClear();
  hapticsState.triggerHapticFeedback.mockReset();
  hapticsState.triggerHapticFeedback.mockReturnValue(true);
  dashboardState.getTokenStatusAction.mockReset();
  dashboardState.getTokenStatusAction.mockResolvedValue({ data: null });
  workspaceActions.createSessionAction.mockReset();
  workspaceActions.getWorkspaceSessionsAction.mockReset();
  workspaceActions.killSessionAction.mockReset();
  workspaceActions.renameSessionAction.mockReset();
  resetFabState();
  terminalState.fit.mockReset();
  terminalState.resize.mockClear();
  terminalState.send.mockClear();
  terminalState.terminalInstances.length = 0;
  pinchZoomState.bindCallCount = 0;
  gestureState.dragConfigs.length = 0;
  gestureState.dragHandlers.length = 0;
  gestureState.gestureConfigs.length = 0;
  gestureState.gestureHandlers.length = 0;
  MockEventSource.instances = [];
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: { addEventListener: vi.fn(), height: 844, removeEventListener: vi.fn() },
  });
  let randomId = 0;
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `uuid-${++randomId}`) });
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("mobile session assembly", () => {
  it("does not mount terminal quick actions on non-terminal dashboard pages", async () => {
    const element = await DashboardLayout({ children: <div>Workspace body</div> });

    render(element);

    expect(screen.getByText("Workspace body")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sidebar-inset"] main')).toHaveClass("pb-0");
    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Terminal quick actions" })).not.toBeInTheDocument();
    expect(hapticsState.triggerHapticFeedback).not.toHaveBeenCalled();
  });

  it("renders the mobile command palette as a bottom sheet with a handle-only drag/tap affordance", async () => {
    const onOpenChange = vi.fn();

    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        tabs={[{ id: "tab-1", sessionName: "hive-main" }]}
        onSelectTab={vi.fn()}
        onCreateSession={vi.fn()}
      />,
    );

    const content = await findSheetContent();
    const handle = screen.getByRole("button", { name: "Drag to dismiss command palette" });

    expect(content).toHaveAttribute("data-side", "bottom");
    expect(content.className).toContain("motion-reduce:transition-none");
    expect(handle).toHaveAttribute("type", "button");
    expect(handle).toHaveClass("h-11");
    expect(handle).toHaveAttribute("data-use-drag-bound", "true");
    expect(document.querySelectorAll('[data-use-drag-bound="true"]')).toHaveLength(1);

    fireEvent.click(handle);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps command-palette drag animation state instant when reduced motion is preferred", async () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        tabs={[{ id: "tab-1", sessionName: "hive-main" }]}
        onSelectTab={vi.fn()}
      />,
    );
    const animatedContent = await findSheetContent();

    act(() => {
      latestDragHandler()({
        active: true,
        direction: [0, 1],
        event: { preventDefault: vi.fn() },
        movement: [0, 24],
        velocity: [0, 0],
      });
    });

    expect(animatedContent.style.transform).toBe("translateY(24px)");
    unmount();

    motionState.reduced = true;
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        tabs={[{ id: "tab-1", sessionName: "hive-main" }]}
        onSelectTab={vi.fn()}
      />,
    );
    const reducedContent = await findSheetContent();

    act(() => {
      latestDragHandler()({
        active: true,
        direction: [0, 1],
        event: { preventDefault: vi.fn() },
        movement: [0, 24],
        velocity: [0, 0],
      });
    });

    expect(reducedContent.style.transform).toBe("");
    expect(reducedContent.style.transition).toBe("");
  });

  it("exposes the touch long-press close-session path and hides close when only one tab remains", async () => {
    workspaceActions.getWorkspaceSessionsAction.mockResolvedValueOnce({
      data: [
        { created: 1000, name: "hive-main", windows: 1 },
        { created: 2000, name: "dev-server", windows: 1 },
      ],
    });
    workspaceActions.killSessionAction.mockResolvedValue({ data: { name: "hive-main" } });

    render(<TerminalTabManager agentId="agent-1" workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(screen.getAllByTestId("tab-label")).toHaveLength(2);
    });

    vi.useFakeTimers();
    fireEvent.pointerDown(screen.getByTestId("terminal-hive-main"), {
      buttons: 1,
      clientX: 120,
      clientY: 333,
      pointerId: 1,
      pointerType: "touch",
    });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    vi.useRealTimers();

    const menu = screen.getByRole("menu", { name: /terminal context menu/i });
    expect(menu).toHaveStyle({ left: "120px", top: "333px" });

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /close session/i }));
    });

    await waitFor(() => {
      expect(workspaceActions.killSessionAction).toHaveBeenCalledWith({
        sessionName: "hive-main",
        workspaceId: "workspace-1",
      });
    });

    cleanup();
    workspaceActions.getWorkspaceSessionsAction.mockResolvedValueOnce({
      data: [{ created: 1000, name: "solo", windows: 1 }],
    });

    render(<TerminalTabManager agentId="agent-1" workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("tab-label")).toHaveTextContent("solo");
    });
    expect(screen.queryByTestId("close-tab")).not.toBeInTheDocument();
  });

  it("binds terminal pinch zoom to the interactive terminal host", async () => {
    const onTerminalReady = vi.fn();

    const { container } = render(
      <InteractiveTerminal
        agentId="agent-1"
        workspaceId="workspace-1"
        sessionName="main"
        onTerminalReady={onTerminalReady}
      />,
    );

    expect(container.querySelector('[data-terminal-pinch-zoom="bound"]')).not.toBeNull();
    expect(pinchZoomState.bindCallCount).toBeGreaterThan(0);

    await waitFor(() => {
      expect(onTerminalReady).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps terminal context-menu actions touch-sized", () => {
    render(
      <TerminalContextMenu
        position={{ x: 100, y: 120 }}
        onClose={vi.fn()}
        hasSelection={false}
        onCopy={vi.fn()}
        onPaste={vi.fn()}
        onNewSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.className).toContain("min-h-11");
      expect(item.className).toContain("touch-manipulation");
    }
  });

  it("carries reduced-motion contracts on shared mobile primitives", async () => {
    const onRefresh = vi.fn();

    render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>Task stream list</div>
      </PullToRefresh>,
    );

    const surface = screen.getByTestId("pull-to-refresh");
    expect(surface).toHaveStyle({ overscrollBehavior: "contain" });
    fireEvent.pointerDown(surface, { buttons: 1, clientX: 20, clientY: 10, pointerType: "touch" });
    fireEvent.pointerMove(surface, { buttons: 1, clientX: 20, clientY: 42, pointerType: "touch" });

    await waitFor(() => {
      const indicator = document.querySelector<HTMLElement>(
        '[data-slot="pull-to-refresh-indicator"]',
      );
      expect(indicator).not.toBeNull();
      expect(indicator?.className).toContain("motion-reduce:transition-none");
      expect(indicator?.className).toContain("motion-reduce:duration-0");
    });
  });

  it("uses auto, never smooth, scrolling while watching agent task stream output", () => {
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);

    render(<AgentStreamPanel taskId="task-mobile" status="running" />);

    const eventSource = MockEventSource.instances[0];
    const viewport = screen.getByTestId("stream-scroll-container");
    setScrollMetrics(viewport, { clientHeight: 400, scrollHeight: 1000, scrollTop: 560 });

    act(() => {
      eventSource.emitMessage("agent output line");
    });

    expect(screen.getByTestId("stream-output")).toHaveTextContent("agent output line");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "end", behavior: "auto" });
    expect(scrollIntoView).not.toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );
  });
});
