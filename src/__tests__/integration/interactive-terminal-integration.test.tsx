// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const {
  mockUseTerminalWebSocket,
  mockFit,
} = vi.hoisted(() => ({
  mockUseTerminalWebSocket: vi.fn(),
  mockFit: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    rows = 24;
    cols = 80;
    open = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
    focus = vi.fn();
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit;
    dispose = vi.fn();
  },
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
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div>{children}</div>,
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

  mockUseTerminalWebSocket.mockReturnValue({
    send: vi.fn(),
    resize: vi.fn(),
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
