/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTerminalShell } from "@/components/terminal/MobileTerminalShell";

vi.mock("@/components/terminal/MobileTerminalDiagnosticsOverlay", () => ({
  MobileTerminalDiagnosticsOverlay: ({ enabled }: { enabled: boolean }) =>
    enabled ? <div data-testid="mobile-terminal-diagnostics-overlay" /> : null,
}));

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  document.body.replaceChildren();
});

describe("MobileTerminalShell", () => {
  it("renders the fixed telemetry shell and optional diagnostics overlay", () => {
    render(
      <MobileTerminalShell diagnosticsEnabled isKeyboardVisible={false}>
        <section data-testid="terminal-content" data-terminal-surface="true" />
      </MobileTerminalShell>,
    );

    expect(screen.getByTestId("terminal-mobile-shell")).toHaveAttribute(
      "data-terminal-shell",
      "true",
    );
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveClass(
      "terminal-mobile-shell",
      "fixed",
      "inset-x-0",
      "overflow-hidden",
      "overscroll-none",
      "top-[calc(var(--safe-area-inset-top)+3.5rem)]",
    );
    expect(screen.getByTestId("terminal-mobile-shell")).toHaveStyle({
      height: "max(0px, calc(var(--app-viewport-height) - var(--safe-area-inset-top) - 3.5rem))",
      maxHeight: "max(0px, calc(var(--app-viewport-height) - var(--safe-area-inset-top) - 3.5rem))",
      top: "calc(var(--safe-area-inset-top) + 3.5rem)",
    });
    expect(screen.getByTestId("terminal-content")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-terminal-diagnostics-overlay")).toBeInTheDocument();
  });

  it("uses visual viewport height while the keyboard is visible", () => {
    render(
      <MobileTerminalShell isKeyboardVisible>
        <div data-testid="terminal-content" />
      </MobileTerminalShell>,
    );

    expect(screen.getByTestId("terminal-mobile-shell")).toHaveStyle({
      height:
        "max(0px, calc(var(--app-visual-viewport-height) - var(--safe-area-inset-top) - 3.5rem))",
      maxHeight:
        "max(0px, calc(var(--app-visual-viewport-height) - var(--safe-area-inset-top) - 3.5rem))",
      top: "calc(var(--safe-area-inset-top) + 3.5rem)",
    });
    expect(screen.queryByTestId("mobile-terminal-diagnostics-overlay")).not.toBeInTheDocument();
  });

  it("locks document scrolling while mounted and restores previous styles on unmount", () => {
    document.documentElement.style.height = "92vh";
    document.documentElement.style.overflow = "auto";
    document.documentElement.style.overscrollBehaviorY = "contain";
    document.body.style.height = "91vh";
    document.body.style.maxHeight = "90vh";
    document.body.style.overflow = "auto";
    document.body.style.overscrollBehaviorY = "contain";
    document.body.style.position = "relative";
    document.body.style.top = "6px";
    document.body.style.width = "calc(100% - 12px)";

    const { unmount } = render(
      <MobileTerminalShell isKeyboardVisible={false}>
        <div data-testid="terminal-content" />
      </MobileTerminalShell>,
    );

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

    unmount();

    expect(document.documentElement.style.height).toBe("92vh");
    expect(document.documentElement.style.overflow).toBe("auto");
    expect(document.documentElement.style.overscrollBehaviorY).toBe("contain");
    expect(document.body.style.height).toBe("91vh");
    expect(document.body.style.maxHeight).toBe("90vh");
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.overscrollBehaviorY).toBe("contain");
    expect(document.body.style.position).toBe("relative");
    expect(document.body.style.top).toBe("6px");
    expect(document.body.style.width).toBe("calc(100% - 12px)");
  });

  it("blocks page scroll outside xterm while allowing terminal scroll", () => {
    render(
      <MobileTerminalShell isKeyboardVisible={false}>
        <div data-testid="outside-control" />
        <div className="xterm">
          <textarea aria-label="xterm helper" />
        </div>
      </MobileTerminalShell>,
    );

    const outsideScroll = new Event("touchmove", { bubbles: true, cancelable: true });
    fireEvent(screen.getByTestId("outside-control"), outsideScroll);
    expect(outsideScroll.defaultPrevented).toBe(true);

    const terminalScroll = new Event("touchmove", { bubbles: true, cancelable: true });
    fireEvent(screen.getByLabelText("xterm helper"), terminalScroll);
    expect(terminalScroll.defaultPrevented).toBe(false);
  });
});
