// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTwoFingerNavigation } from "@/hooks/useTwoFingerNavigation";

function NavigationHarness({ onNavigate }: { onNavigate: ReturnType<typeof vi.fn> }) {
  const rootRef = useRef<HTMLElement>(null);
  useTwoFingerNavigation({ enabled: true, onNavigate, rootRef });
  return (
    <section ref={rootRef} data-workspace-navigation-surface="true">
      <div data-terminal-navigation-surface="true" data-testid="terminal-surface">
        <div data-testid="terminal-header">Terminal header</div>
      </div>
      <div data-workspace-navigation-surface="true" data-testid="workspace-surface" />
      <div data-testid="workspace-root-surface">Workspace header</div>
    </section>
  );
}

function touch(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY };
}

function dispatchTouch(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend",
  touches: ReturnType<typeof touch>[],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
  return event;
}

describe("useTwoFingerNavigation", () => {
  afterEach(cleanup);

  it("routes horizontal two-finger swipes by their navigation surface", () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminal = screen.getByTestId("terminal-surface");
    const terminalStart = dispatchTouch(terminal, "touchstart", [
      touch(1, 140, 80),
      touch(2, 200, 80),
    ]);
    const terminalMove = dispatchTouch(terminal, "touchmove", [
      touch(1, 70, 82),
      touch(2, 130, 82),
    ]);
    dispatchTouch(terminal, "touchend", []);

    expect(terminalStart.defaultPrevented).toBe(true);
    expect(terminalMove.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("terminal", "left");

    const workspace = screen.getByTestId("workspace-surface");
    dispatchTouch(workspace, "touchstart", [touch(3, 80, 80), touch(4, 140, 80)]);
    dispatchTouch(workspace, "touchmove", [touch(3, 150, 82), touch(4, 210, 82)]);
    dispatchTouch(workspace, "touchend", []);

    expect(onNavigate).toHaveBeenLastCalledWith("workspace", "right");
  });

  it("blocks native pinch zoom without navigating", () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminal = screen.getByTestId("terminal-surface");
    const start = dispatchTouch(terminal, "touchstart", [touch(1, 100, 80), touch(2, 160, 80)]);
    const move = dispatchTouch(terminal, "touchmove", [touch(1, 60, 80), touch(2, 200, 80)]);
    dispatchTouch(terminal, "touchend", []);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("routes gestures from the full terminal pane and workspace root", () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminalHeader = screen.getByTestId("terminal-header");
    dispatchTouch(terminalHeader, "touchstart", [touch(1, 180, 80), touch(2, 220, 120)]);
    dispatchTouch(terminalHeader, "touchmove", [touch(1, 110, 82), touch(2, 150, 122)]);
    dispatchTouch(terminalHeader, "touchend", []);
    expect(onNavigate).toHaveBeenLastCalledWith("terminal", "left");

    const workspaceRootSurface = screen.getByTestId("workspace-root-surface");
    dispatchTouch(workspaceRootSurface, "touchstart", [touch(3, 80, 80), touch(4, 120, 120)]);
    dispatchTouch(workspaceRootSurface, "touchmove", [touch(3, 150, 82), touch(4, 190, 122)]);
    dispatchTouch(workspaceRootSurface, "touchend", []);
    expect(onNavigate).toHaveBeenLastCalledWith("workspace", "right");
  });
});
