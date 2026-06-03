// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTerminalDiagnosticsOverlay } from "@/components/terminal/MobileTerminalDiagnosticsOverlay";
import { getMobileTerminalDiagnosticsState } from "@/lib/terminal/mobile-terminal-diagnostics-state";
import type { MobileViewportDiagnosticsSnapshot } from "@/lib/terminal/mobile-viewport-diagnostics";

function makeSnapshot(
  terminalOverrides: Partial<MobileViewportDiagnosticsSnapshot["terminal"]> = {},
): MobileViewportDiagnosticsSnapshot {
  const terminal = {
    shellRect: {
      x: 0,
      y: 80,
      width: 390,
      height: 500,
      top: 80,
      right: 390,
      bottom: 580,
      left: 0,
    },
    helperTextareaRect: {
      x: 8,
      y: 460,
      width: 1,
      height: 1,
      top: 460,
      right: 9,
      bottom: 461,
      left: 8,
    },
    ...getMobileTerminalDiagnosticsState(),
    ...terminalOverrides,
  };

  return {
    version: 1,
    sampledAt: 1234,
    viewport: {
      layout: { width: 390, height: 800 },
      visual: {
        width: 390,
        height: 500,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 300,
        scale: 1,
      },
      keyboardInsetBottom: 300,
    },
    document: {
      scrollX: 0,
      scrollY: 300,
      documentElement: {
        clientWidth: 390,
        clientHeight: 800,
        scrollWidth: 390,
        scrollHeight: 1100,
        offsetWidth: 390,
        offsetHeight: 800,
      },
      body: null,
    },
    cssVars: {
      "--app-visual-viewport-height": "500px",
      "--app-visual-viewport-offset-top": "0px",
    },
    activeElement: {
      tagName: "textarea",
      id: null,
      role: null,
      testId: null,
      ariaLabel: "Terminal input",
      className: "xterm-helper-textarea",
      type: null,
      inputMode: null,
    },
    terminal,
  };
}

describe("MobileTerminalDiagnosticsOverlay", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing and does not sample when disabled", () => {
    const sampler = vi.fn();

    render(<MobileTerminalDiagnosticsOverlay enabled={false} sampler={sampler} />);

    expect(screen.queryByLabelText("Mobile terminal diagnostics")).not.toBeInTheDocument();
    expect(sampler).not.toHaveBeenCalled();
  });

  it("renders compact read-only viewport, terminal geometry, and resize evidence when enabled", async () => {
    const sampler = vi.fn(() =>
      makeSnapshot({
        xterm: { rows: 28, cols: 96, updatedAt: 150, source: "terminal-open" },
        fit: {
          count: 1,
          lastAt: 100,
          lastSource: "initial-layout-refit",
          rows: 24,
          cols: 80,
        },
        resizeRequest: {
          count: 2,
          lastAt: 200,
          lastSource: "xterm-on-resize",
          rows: 28,
          cols: 96,
        },
        resizeSent: {
          count: 2,
          lastAt: 225,
          lastSource: "xterm-on-resize",
          rows: 28,
          cols: 96,
        },
      }),
    );

    render(<MobileTerminalDiagnosticsOverlay enabled sampler={sampler} />);

    expect(await screen.findByText("Mobile viewport diagnostics")).toBeInTheDocument();
    await waitFor(() => expect(sampler).toHaveBeenCalledTimes(1));
    expect(screen.getByText("390px × 800px")).toBeInTheDocument();
    expect(screen.getByText("390px × 500px")).toBeInTheDocument();
    expect(screen.getAllByText("300px")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy diagnostics JSON report" })).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByText("390×500 at 0,80")).toBeInTheDocument();
    expect(screen.getByText("1×1 at 8,460")).toBeInTheDocument();
    expect(screen.getByText("textarea")).toBeInTheDocument();
    expect(screen.getByText("28 rows × 96 cols")).toBeInTheDocument();
    expect(
      screen.getByText("resize request: xterm-on-resize @ 200 (28 rows × 96 cols, count 2)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("resize sent: xterm-on-resize @ 225 (28 rows × 96 cols, count 2)"),
    ).toBeInTheDocument();
  });

  it("copies the current diagnostics snapshot as redacted JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const sampler = vi.fn(() =>
      makeSnapshot({
        xterm: { rows: 28, cols: 96, updatedAt: 150, source: "terminal-open" },
        resizeSent: {
          count: 1,
          lastAt: 225,
          lastSource: "xterm-on-resize",
          rows: 28,
          cols: 96,
        },
      }),
    );

    render(<MobileTerminalDiagnosticsOverlay enabled sampler={sampler} />);

    expect(await screen.findByText("Mobile viewport diagnostics")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics JSON report" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedReport = writeText.mock.calls[0]?.[0];
    expect(copiedReport).toEqual(expect.stringContaining('"keyboardInsetBottom": 300'));
    expect(copiedReport).toEqual(expect.stringContaining('"helperTextareaRect"'));
    expect(copiedReport).toEqual(expect.stringContaining('"resizeSent"'));
    expect(copiedReport).not.toEqual(expect.stringContaining("SECRET"));
    expect(copiedReport).not.toEqual(expect.stringContaining("cloneProof"));
    expect(copiedReport).not.toEqual(expect.stringContaining("command input"));
    expect(copiedReport).not.toEqual(expect.stringContaining("helperTextareaValue"));
    expect(await screen.findByText("Copied diagnostics JSON")).toBeInTheDocument();
  });

  it("shows a visible failure status when clipboard write is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const sampler = vi.fn(() => makeSnapshot());

    render(<MobileTerminalDiagnosticsOverlay enabled sampler={sampler} />);

    expect(await screen.findByText("Mobile viewport diagnostics")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics JSON report" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Copy failed")).toBeInTheDocument();
  });

  it("renders missing values instead of throwing when xterm and resize evidence are absent", async () => {
    const sampler = vi.fn(() =>
      makeSnapshot({
        shellRect: null,
        helperTextareaRect: null,
      }),
    );

    render(<MobileTerminalDiagnosticsOverlay enabled sampler={sampler} />);

    expect(await screen.findByText("Mobile viewport diagnostics")).toBeInTheDocument();
    expect(screen.getAllByText("missing").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("Xterm size")).toBeInTheDocument();
    expect(screen.getByText("Latest resize")).toBeInTheDocument();
    expect(screen.getByText("WS resize sent")).toBeInTheDocument();
  });

  it("resamples while visible and stops polling after unmount", () => {
    vi.useFakeTimers();
    const sampler = vi.fn(() => makeSnapshot());

    const { unmount } = render(
      <MobileTerminalDiagnosticsOverlay enabled sampleIntervalMs={250} sampler={sampler} />,
    );

    expect(sampler).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(sampler).toHaveBeenCalledTimes(3);
    unmount();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(sampler).toHaveBeenCalledTimes(3);
  });
});
