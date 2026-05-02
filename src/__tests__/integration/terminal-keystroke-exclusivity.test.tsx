// @vitest-environment jsdom

import { act, fireEvent, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFit, mockFocus } = vi.hoisted(() => ({
  mockFit: vi.fn(),
  mockFocus: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    rows = 24;
    cols = 80;
    focus = mockFocus;
    open = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit;
    dispose = vi.fn();
  },
}));

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: () => ({
    send: vi.fn(),
    resize: vi.fn(),
    connectionState: "disconnected",
  }),
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

vi.mock("@/lib/terminal/config", () => ({
  TERMINAL_THEME: {},
  TERMINAL_FONT_FAMILY: "monospace",
  loadTerminalFont: () => Promise.resolve(),
}));

vi.mock("@/styles/xterm.css", () => ({}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  mockFit.mockClear();
  mockFocus.mockClear();

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

async function renderTerminal(wrapper?: React.ComponentType<{ children: React.ReactNode }>) {
  const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");

  const element = (
    <InteractiveTerminal agentId="test-agent" workspaceId="test-ws" sessionName="main" />
  );

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(wrapper ? React.createElement(wrapper, null, element) : element);
  });

  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  return result!;
}

describe("Terminal keystroke exclusivity (R069)", () => {
  it("calls term.focus() after mount", async () => {
    const { unmount } = await renderTerminal();
    expect(mockFocus).toHaveBeenCalled();
    unmount();
  });

  it("keydown events on container do not bubble to parent when wrapped with stopPropagation", async () => {
    const parentSpy = vi.fn();

    function StopPropWrapper({ children }: { children: React.ReactNode }) {
      return (
        <div onKeyDown={parentSpy}>
          <div onKeyDown={(e) => e.stopPropagation()}>{children}</div>
        </div>
      );
    }

    const { container, unmount } = await renderTerminal(StopPropWrapper);

    const terminalContainer = container.querySelector(".flex-1");
    expect(terminalContainer).not.toBeNull();

    fireEvent.keyDown(terminalContainer!, { key: "a", code: "KeyA" });

    expect(parentSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("clicking terminal container calls term.focus()", async () => {
    const { container, unmount } = await renderTerminal();

    mockFocus.mockClear();

    const terminalContainer = container.querySelector(".flex-1");
    expect(terminalContainer).not.toBeNull();

    fireEvent.click(terminalContainer!);

    expect(mockFocus).toHaveBeenCalled();
    unmount();
  });
});
