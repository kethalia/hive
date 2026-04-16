// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const mockFit = vi.fn();

vi.mock("@xterm/xterm", () => {
  return {
    Terminal: class MockTerminal {
      rows = 24;
      cols = 80;
      open = vi.fn();
      loadAddon = vi.fn();
      onData = vi.fn();
      onResize = vi.fn();
      onScroll = vi.fn();
      dispose = vi.fn();
      write = vi.fn();
      scrollToBottom = vi.fn();
    },
  };
});

vi.mock("@xterm/addon-fit", () => {
  return {
    FitAddon: class MockFitAddon {
      fit = mockFit;
    },
  };
});

vi.mock("@/lib/terminal/protocol", () => ({
  encodeInput: (data: string) => data,
}));

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: () => ({
    send: vi.fn(),
    resize: vi.fn(),
    connectionState: "disconnected",
  }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
}));

vi.mock("@/styles/xterm.css", () => ({}));

type ResizeObserverCallback = (entries: Array<{ contentRect: { width: number; height: number } }>) => void;

let resizeObserverCallback: ResizeObserverCallback | null = null;
let resizeObserverDisconnected = false;
let resizeObserverTarget: Element | null = null;

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
    resizeObserverDisconnected = false;
  }
  observe(target: Element) {
    resizeObserverTarget = target;
  }
  unobserve() {}
  disconnect() {
    resizeObserverDisconnected = true;
  }
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  resizeObserverCallback = null;
  resizeObserverDisconnected = false;
  resizeObserverTarget = null;
  mockFit.mockClear();
  Object.defineProperty(document, "fonts", {
    value: { ready: Promise.resolve() },
    configurable: true,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      />
    );
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  return result!;
}

describe("ResizeObserver-based terminal re-fit", () => {
  it("calls fit() when ResizeObserver fires with non-zero dimensions", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverCallback).not.toBeNull();
    mockFit.mockClear();

    act(() => {
      resizeObserverCallback!([{ contentRect: { width: 800, height: 600 } }]);
    });

    expect(mockFit).toHaveBeenCalled();
    unmount();
  });

  it("does NOT call fit() when dimensions are 0x0", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverCallback).not.toBeNull();
    mockFit.mockClear();

    act(() => {
      resizeObserverCallback!([{ contentRect: { width: 0, height: 0 } }]);
    });

    expect(mockFit).not.toHaveBeenCalled();
    unmount();
  });

  it("disconnects observer on unmount", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverCallback).not.toBeNull();
    expect(resizeObserverDisconnected).toBe(false);

    unmount();

    expect(resizeObserverDisconnected).toBe(true);
  });

  it("observes the container element", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverTarget).not.toBeNull();
    expect(resizeObserverTarget).toBeInstanceOf(HTMLDivElement);

    unmount();
  });
});
