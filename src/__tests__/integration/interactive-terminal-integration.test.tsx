// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseTerminalWebSocket, mockFit, mockSend, mockResize, terminalInstances } = vi.hoisted(
  () => ({
    mockUseTerminalWebSocket: vi.fn(),
    mockFit: vi.fn(),
    mockSend: vi.fn(),
    mockResize: vi.fn(),
    terminalInstances: [] as Array<{
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      buffer: { active: { baseY: number; viewportY: number } };
      dataHandler?: (data: string) => void;
      focus: ReturnType<typeof vi.fn>;
      onData: ReturnType<typeof vi.fn>;
      scrollLines: ReturnType<typeof vi.fn>;
      scrollToBottom: ReturnType<typeof vi.fn>;
    }>,
  }),
);

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    rows = 24;
    cols = 80;
    buffer = { active: { baseY: 10, viewportY: 9 } };
    open = vi.fn((element: HTMLElement) => {
      const terminal = document.createElement("div");
      terminal.className = "xterm";
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.appendChild(helper);
      element.appendChild(terminal);
    });
    loadAddon = vi.fn();
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    });
    onResize = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    scrollLines = vi.fn();
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    });
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
    clearSelection = vi.fn();
    dataHandler?: (data: string) => void;

    constructor() {
      terminalInstances.push(this);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit;
    dispose = vi.fn();
  },
}));

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: (...args: unknown[]) => mockUseTerminalWebSocket(...args),
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
  AlertDescription: ({ children }: { children: React.ReactNode; className?: string }) => (
    <div>{children}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
}));

vi.mock("@/styles/xterm.css", () => ({}));

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
  mockFit.mockClear();
  mockSend.mockClear();
  mockResize.mockClear();
  terminalInstances.length = 0;
  window.localStorage.clear();

  mockUseTerminalWebSocket.mockReturnValue({
    send: mockSend,
    resize: mockResize,
    connectionState: "disconnected",
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

async function renderTerminal(
  props: { layoutSignal?: unknown; mobileInputMode?: boolean; pinToBottomOnResize?: boolean } = {},
) {
  const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <InteractiveTerminal
        agentId="test-agent"
        workspaceId="test-ws"
        sessionName="main"
        {...props}
      />,
    );
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  return result!;
}

function terminalWebSocketUrls() {
  return mockUseTerminalWebSocket.mock.calls
    .map(([options]) => (options as { url: string | null }).url)
    .filter((url): url is string => typeof url === "string");
}

function touchPoint(identifier: number, clientX: number, clientY: number): Touch {
  return { identifier, clientX, clientY } as Touch;
}

function fireTouchEvent(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: Touch[],
  changedTouches = touches,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changedTouches });
  fireEvent(target, event);
  return event;
}

describe("InteractiveTerminal integration — Connection state banners", () => {
  it("shows workspace offline banner", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "workspace-offline",
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Workspace is offline");
    unmount();
  });

  it("shows connection failed banner", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "failed",
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Connection failed");
    unmount();
  });

  it("shows no banner when disconnected", async () => {
    const { container, unmount } = await renderTerminal();
    expect(container.textContent).not.toContain("offline");
    expect(container.textContent).not.toContain("failed");
    unmount();
  });
});

describe("InteractiveTerminal integration — ResizeObserver", () => {
  it("calls fit() when container resizes with non-zero dimensions", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverCallback).not.toBeNull();
    mockFit.mockClear();

    act(() => {
      resizeObserverCallback!([{ contentRect: { width: 800, height: 600 } }]);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(mockFit).toHaveBeenCalled();
    unmount();
  });

  it("skips fit() when dimensions are zero (hidden container)", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverCallback).not.toBeNull();
    mockFit.mockClear();

    act(() => {
      resizeObserverCallback!([{ contentRect: { width: 0, height: 0 } }]);
    });

    expect(mockFit).not.toHaveBeenCalled();
    unmount();
  });
});

describe("InteractiveTerminal integration — Session lifecycle", () => {
  it("reuses cached reconnect IDs and builds the WebSocket URL with session dimensions", async () => {
    window.localStorage.setItem(
      "terminal:reconnect:test-agent:main",
      JSON.stringify({ id: "cached-reconnect", ts: Date.now() }),
    );

    const { unmount } = await renderTerminal();

    await waitFor(() => {
      expect(terminalWebSocketUrls().length).toBeGreaterThan(0);
    });
    const url = new URL(terminalWebSocketUrls().at(-1)!);
    expect(url.origin).toBe("ws://localhost:9999");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("agentId")).toBe("test-agent");
    expect(url.searchParams.get("workspaceId")).toBe("test-ws");
    expect(url.searchParams.get("sessionName")).toBe("main");
    expect(url.searchParams.get("reconnectId")).toBe("cached-reconnect");
    expect(url.searchParams.get("width")).toBe("80");
    expect(url.searchParams.get("height")).toBe("24");
    unmount();
  });

  it("resizes the PTY after connection and preserves bottom pinning when configured", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: mockSend,
      resize: mockResize,
      connectionState: "connected",
    });

    const { unmount } = await renderTerminal({ pinToBottomOnResize: true });
    const terminal = terminalInstances.at(-1);

    await waitFor(() => {
      expect(mockResize).toHaveBeenCalledWith(24, 80);
    });
    expect(terminal?.scrollToBottom).toHaveBeenCalled();
    expect(terminal?.buffer.active.viewportY).toBe(terminal?.buffer.active.baseY);
    unmount();
  });
});

describe("InteractiveTerminal integration — Mobile input adapter", () => {
  it("applies mobile helper attributes only in mobile input mode", async () => {
    const mobile = await renderTerminal({ mobileInputMode: true });
    const mobileHelper = mobile.container.querySelector(".xterm-helper-textarea");

    expect(mobileHelper).toHaveAttribute("data-terminal-mobile-input", "true");
    expect(mobileHelper).toHaveAttribute("autocapitalize", "off");
    expect(mobileHelper).toHaveAttribute("autocorrect", "off");
    expect(mobileHelper).toHaveAttribute("autocomplete", "off");
    expect(mobileHelper).toHaveAttribute("spellcheck", "false");
    expect(mobileHelper).toHaveAttribute("inputmode", "text");
    expect(mobileHelper).toHaveAttribute("enterkeyhint", "enter");
    expect((mobileHelper as HTMLTextAreaElement).style.fontSize).toBe("16px");
    mobile.unmount();

    const desktop = await renderTerminal({ mobileInputMode: false });
    const desktopHelper = desktop.container.querySelector(".xterm-helper-textarea");

    expect(desktopHelper).not.toHaveAttribute("data-terminal-mobile-input");
    expect(desktopHelper).not.toHaveAttribute("autocorrect");
    desktop.unmount();
  });

  it("does not focus xterm from mobile terminal surface touches", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();
    expect(terminal?.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);

    terminal?.focus.mockClear();
    const inputTarget = container.querySelector(".flex-1.p-1");
    expect(inputTarget).toBeTruthy();

    fireEvent.pointerDown(inputTarget as Element, {
      clientX: 80,
      clientY: 240,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerUp(inputTarget as Element, {
      clientX: 82,
      clientY: 242,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.click(inputTarget as Element);

    expect(terminal?.focus).not.toHaveBeenCalled();

    act(() => {
      terminal?.dataHandler?.("echo mobile\r");
    });
    expect(mockSend).toHaveBeenCalledWith("echo mobile\r");
    unmount();
  });

  it("scrolls mobile terminal touch drags without allowing native page scroll or keyboard focus", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();

    terminal?.focus.mockClear();
    terminal?.scrollLines.mockClear();
    const inputTarget = container.querySelector(".flex-1.p-1");
    expect(inputTarget).toBeTruthy();

    fireTouchEvent(inputTarget as Element, "touchstart", [touchPoint(1, 80, 320)]);
    const touchMove = fireTouchEvent(inputTarget as Element, "touchmove", [touchPoint(1, 80, 240)]);
    fireTouchEvent(inputTarget as Element, "touchend", [], [touchPoint(1, 80, 240)]);
    fireEvent.click(inputTarget as Element);

    expect(touchMove.defaultPrevented).toBe(true);
    expect(terminal?.scrollLines).toHaveBeenCalledWith(4);
    expect(terminal?.focus).not.toHaveBeenCalled();
    unmount();
  });

  it("keeps desktop pointer entry focusing immediately", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: false });
    const terminal = terminalInstances.at(-1);
    terminal?.focus.mockClear();
    const inputTarget = container.querySelector(".flex-1.p-1");
    expect(inputTarget).toBeTruthy();

    fireEvent.pointerDown(inputTarget as Element, {
      clientX: 80,
      clientY: 240,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(terminal?.focus).toHaveBeenCalledTimes(1);
    unmount();
  });
});
