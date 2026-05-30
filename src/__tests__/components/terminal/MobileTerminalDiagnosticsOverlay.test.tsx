// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTerminalDiagnosticsOverlay } from "@/components/terminal/MobileTerminalDiagnosticsOverlay";
import type { MobileViewportDiagnosticsSnapshot } from "@/lib/terminal/mobile-viewport-diagnostics";

function makeSnapshot(): MobileViewportDiagnosticsSnapshot {
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
    terminal: {
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
    },
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

  it("renders compact read-only viewport and terminal geometry when enabled", async () => {
    const sampler = vi.fn(() => makeSnapshot());

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
  });

  it("copies the current diagnostics snapshot as JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const sampler = vi.fn(() => makeSnapshot());

    render(<MobileTerminalDiagnosticsOverlay enabled sampler={sampler} />);

    expect(await screen.findByText("Mobile viewport diagnostics")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics JSON report" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedReport = writeText.mock.calls[0]?.[0];
    expect(copiedReport).toEqual(expect.stringContaining('"keyboardInsetBottom": 300'));
    expect(copiedReport).toEqual(expect.stringContaining('"helperTextareaRect"'));
    expect(copiedReport).not.toEqual(expect.stringContaining("SECRET"));
    expect(await screen.findByText("Copied diagnostics JSON")).toBeInTheDocument();
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
