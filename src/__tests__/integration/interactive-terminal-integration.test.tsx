// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";

const {
  mockUseScrollbackHydration,
  mockUseTerminalWebSocket,
  mockReconnect,
  mockScrollToBottom,
  capturedOnScroll,
  mockBuffer,
  mockFit,
} = vi.hoisted(() => ({
  mockUseScrollbackHydration: vi.fn(),
  mockUseTerminalWebSocket: vi.fn(),
  mockReconnect: vi.fn(),
  mockScrollToBottom: vi.fn(),
  capturedOnScroll: { current: null as ((args?: unknown) => void) | null },
  mockBuffer: { active: { viewportY: 100, baseY: 100 } },
  mockFit: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    rows = 24;
    cols = 80;
    buffer = mockBuffer;
    open = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    onScroll = vi.fn((cb: (args?: unknown) => void) => {
      capturedOnScroll.current = cb;
    });
    dispose = vi.fn();
    write = vi.fn();
    scrollToBottom = mockScrollToBottom;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit;
    dispose = vi.fn();
  },
}));

vi.mock("@/hooks/useScrollbackHydration", () => ({
  useScrollbackHydration: (...args: unknown[]) =>
    mockUseScrollbackHydration(...args),
}));

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: (...args: unknown[]) =>
    mockUseTerminalWebSocket(...args),
}));

vi.mock("@/lib/terminal/protocol", () => ({
  encodeInput: (data: string) => data,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => (
    <div data-testid="alert" data-variant={props.variant}>
      {children}
    </div>
  ),
  AlertDescription: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
    className?: string;
    "aria-label"?: string;
  }) => (
    <button onClick={onClick} aria-label={props["aria-label"]}>
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
  ArrowDown: () => null,
  Loader2: () => null,
  RefreshCw: () => null,
}));

vi.mock("@/styles/xterm.css", () => ({}));

vi.mock("@/components/workspaces/TerminalHistoryPanel", () => ({
  TerminalHistoryPanel: ({
    visible,
    reconnectId,
    onScrollToBottom,
  }: {
    visible: boolean;
    reconnectId: string | null;
    onScrollToBottom?: () => void;
  }) => (
    <div
      data-testid="history-panel"
      data-visible={String(visible)}
      data-reconnect-id={reconnectId}
      onClick={onScrollToBottom}
    />
  ),
}));

vi.mock("@/components/workspaces/JumpToBottom", () => ({
  JumpToBottom: ({
    visible,
    onClick,
  }: {
    visible: boolean;
    onClick: () => void;
  }) => (
    <button
      data-testid="jump-to-bottom"
      data-visible={String(visible)}
      onClick={onClick}
    >
      Jump to bottom
    </button>
  ),
}));

type ResizeObserverCallback = (
  entries: Array<{ contentRect: { width: number; height: number } }>,
) => void;

let resizeObserverCallback: ResizeObserverCallback | null = null;

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  resizeObserverCallback = null;
  capturedOnScroll.current = null;
  mockBuffer.active.viewportY = 100;
  mockBuffer.active.baseY = 100;
  mockFit.mockClear();
  mockReconnect.mockClear();
  mockScrollToBottom.mockClear();

  mockUseScrollbackHydration.mockReturnValue({
    hydrationState: "idle",
    isGatingLiveData: false,
  });

  mockUseTerminalWebSocket.mockReturnValue({
    send: vi.fn(),
    resize: vi.fn(),
    connectionState: "disconnected",
    reconnectAttempt: 0,
    reconnect: mockReconnect,
  });

  Object.defineProperty(document, "fonts", {
    value: { ready: Promise.resolve() },
    configurable: true,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 0;
  });

  process.env.NEXT_PUBLIC_TERMINAL_WS_URL = "ws://localhost:9999";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_TERMINAL_WS_URL;
});

async function renderTerminal() {
  const { InteractiveTerminal } = await import(
    "@/components/workspaces/InteractiveTerminal"
  );

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <InteractiveTerminal
        agentId="test-agent"
        workspaceId="test-ws"
        sessionName="main"
      />,
    );
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  return result!;
}

describe("InteractiveTerminal integration — Hydration banners", () => {
  it("shows 'Restoring history…' when hydrationState is loading", async () => {
    mockUseScrollbackHydration.mockReturnValue({
      hydrationState: "loading",
      isGatingLiveData: true,
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Restoring history");
    unmount();
  });

  it("shows 'History unavailable' when hydrationState is error", async () => {
    mockUseScrollbackHydration.mockReturnValue({
      hydrationState: "error",
      isGatingLiveData: false,
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("History unavailable");
    unmount();
  });

  it("shows no hydration banner when hydrationState is hydrated", async () => {
    mockUseScrollbackHydration.mockReturnValue({
      hydrationState: "hydrated",
      isGatingLiveData: false,
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).not.toContain("Restoring history");
    expect(container.textContent).not.toContain("History unavailable");
    unmount();
  });
});

describe("InteractiveTerminal integration — Connection state banners", () => {
  it("shows reconnecting banner with attempt count", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "reconnecting",
      reconnectAttempt: 5,
      reconnect: mockReconnect,
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Reconnecting");
    expect(container.textContent).toContain("5");
    unmount();
  });

  it("shows failed banner with Reconnect Now button", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "failed",
      reconnectAttempt: 0,
      reconnect: mockReconnect,
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Connection failed");
    expect(container.textContent).toContain("Reconnect Now");
    unmount();
  });

  it("calls reconnect() when Reconnect Now is clicked in failed state", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "failed",
      reconnectAttempt: 0,
      reconnect: mockReconnect,
    });

    const { container, unmount } = await renderTerminal();
    const buttons = container.querySelectorAll("button");
    const reconnectBtn = Array.from(buttons).find(
      (b) => b.textContent === "Reconnect Now",
    );
    expect(reconnectBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(reconnectBtn!);
    });

    expect(mockReconnect).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("InteractiveTerminal integration — History panel and scroll UX", () => {
  it("shows history panel when scrolled to top (viewportY=0)", async () => {
    const { container, unmount } = await renderTerminal();

    const historyPanel = container.querySelector(
      '[data-testid="history-panel"]',
    );
    expect(historyPanel?.getAttribute("data-visible")).toBe("false");

    mockBuffer.active.viewportY = 0;
    mockBuffer.active.baseY = 100;

    expect(capturedOnScroll.current).not.toBeNull();
    act(() => {
      capturedOnScroll.current!();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    expect(historyPanel?.getAttribute("data-visible")).toBe("true");
    unmount();
  });

  it("shows JumpToBottom when not at bottom", async () => {
    const { container, unmount } = await renderTerminal();

    const jumpBtn = container.querySelector('[data-testid="jump-to-bottom"]');
    expect(jumpBtn?.getAttribute("data-visible")).toBe("false");

    mockBuffer.active.viewportY = 50;
    mockBuffer.active.baseY = 100;

    act(() => {
      capturedOnScroll.current!();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    expect(jumpBtn?.getAttribute("data-visible")).toBe("true");
    unmount();
  });

  it("clicking JumpToBottom calls scrollToBottom and hides panel", async () => {
    const { container, unmount } = await renderTerminal();

    mockBuffer.active.viewportY = 0;
    mockBuffer.active.baseY = 100;
    act(() => {
      capturedOnScroll.current!();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    const jumpBtn = container.querySelector('[data-testid="jump-to-bottom"]');
    expect(jumpBtn?.getAttribute("data-visible")).toBe("true");

    await act(async () => {
      fireEvent.click(jumpBtn!);
    });

    expect(mockScrollToBottom).toHaveBeenCalled();
    expect(jumpBtn?.getAttribute("data-visible")).toBe("false");
    unmount();
  });

  it("reconnecting banner shows Reconnect Now that triggers reconnect", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "reconnecting",
      reconnectAttempt: 3,
      reconnect: mockReconnect,
    });

    const { container, unmount } = await renderTerminal();
    const buttons = container.querySelectorAll("button");
    const reconnectBtn = Array.from(buttons).find(
      (b) => b.textContent === "Reconnect Now",
    );
    expect(reconnectBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(reconnectBtn!);
    });

    expect(mockReconnect).toHaveBeenCalledTimes(1);
    unmount();
  });
});
