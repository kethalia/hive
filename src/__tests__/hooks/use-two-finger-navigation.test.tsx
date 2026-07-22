// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTwoFingerNavigation } from "@/hooks/useTwoFingerNavigation";
import { TERMINAL_MULTI_TOUCH_CLAIM_EVENT } from "@/lib/terminal/events";

function NavigationHarness({ onNavigate }: { onNavigate: ReturnType<typeof vi.fn> }) {
  const rootRef = useRef<HTMLElement>(null);
  useTwoFingerNavigation({ enabled: true, onNavigate, rootRef });
  return (
    <section ref={rootRef} data-workspace-navigation-surface="true">
      <div data-terminal-navigation-surface="true" data-testid="terminal-surface">
        <div data-testid="terminal-header">Terminal header</div>
        <div data-testid="terminal-fit-host" />
      </div>
      <div data-workspace-navigation-surface="true" data-testid="workspace-surface" />
      <div data-testid="workspace-root-surface">Workspace header</div>
    </section>
  );
}

function RapidNavigationHarness({ onNavigate }: { onNavigate: ReturnType<typeof vi.fn> }) {
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLElement>(null);

  useTwoFingerNavigation({
    enabled: true,
    rootRef,
    onNavigate: (surface, direction) => {
      onNavigate(index, surface, direction);
      setIndex((current) => current + (direction === "left" ? -1 : 1));
    },
  });

  useLayoutEffect(() => {
    if (index !== -1) return;
    const terminal = rootRef.current?.querySelector('[data-testid="rapid-terminal-surface"]');
    if (!terminal) return;
    dispatchTouch(terminal, "touchstart", [touch(3, 80, 80), touch(4, 140, 80)]);
    dispatchTouch(terminal, "touchmove", [touch(3, 150, 82), touch(4, 210, 82)]);
    dispatchTouch(terminal, "touchend", []);
  }, [index]);

  return (
    <section ref={rootRef} data-workspace-navigation-surface="true">
      <div data-terminal-navigation-surface="true" data-testid="rapid-terminal-surface" />
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

  it("routes horizontal two-finger swipes by their navigation surface", async () => {
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
    await Promise.resolve();

    expect(terminalStart.defaultPrevented).toBe(true);
    expect(terminalMove.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("terminal", "left");

    const workspace = screen.getByTestId("workspace-surface");
    dispatchTouch(workspace, "touchstart", [touch(3, 80, 80), touch(4, 140, 80)]);
    dispatchTouch(workspace, "touchmove", [touch(3, 150, 82), touch(4, 210, 82)]);
    dispatchTouch(workspace, "touchend", []);
    await Promise.resolve();

    expect(onNavigate).toHaveBeenLastCalledWith("workspace", "right");
  });

  it("uses the latest navigation state before passive effects flush", async () => {
    const onNavigate = vi.fn();
    render(<RapidNavigationHarness onNavigate={onNavigate} />);

    const terminal = screen.getByTestId("rapid-terminal-surface");
    dispatchTouch(terminal, "touchstart", [touch(1, 140, 80), touch(2, 200, 80)]);
    dispatchTouch(terminal, "touchmove", [touch(1, 70, 82), touch(2, 130, 82)]);
    dispatchTouch(terminal, "touchend", []);

    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2));
    expect(onNavigate).toHaveBeenNthCalledWith(1, 0, "terminal", "left");
    expect(onNavigate).toHaveBeenNthCalledWith(2, -1, "terminal", "right");
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

  it("uses the one-pointer swipe rule for the two-touch centroid when touch updates arrive unevenly", async () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminal = screen.getByTestId("terminal-surface");
    dispatchTouch(terminal, "touchstart", [touch(1, 140, 80)]);
    dispatchTouch(terminal, "touchstart", [touch(1, 140, 80), touch(2, 180, 80)]);
    dispatchTouch(terminal, "touchmove", [touch(1, 10, 84), touch(2, 180, 80)]);
    dispatchTouch(terminal, "touchend", []);
    await Promise.resolve();

    expect(onNavigate).toHaveBeenCalledWith("terminal", "left");
  });

  it("routes gestures from the full terminal pane and workspace root", async () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminalHeader = screen.getByTestId("terminal-header");
    dispatchTouch(terminalHeader, "touchstart", [touch(1, 180, 80), touch(2, 220, 120)]);
    dispatchTouch(terminalHeader, "touchmove", [touch(1, 110, 82), touch(2, 150, 122)]);
    dispatchTouch(terminalHeader, "touchend", []);
    await Promise.resolve();
    expect(onNavigate).toHaveBeenLastCalledWith("terminal", "left");

    const workspaceRootSurface = screen.getByTestId("workspace-root-surface");
    dispatchTouch(workspaceRootSurface, "touchstart", [touch(3, 80, 80), touch(4, 120, 120)]);
    dispatchTouch(workspaceRootSurface, "touchmove", [touch(3, 150, 82), touch(4, 190, 122)]);
    dispatchTouch(workspaceRootSurface, "touchend", []);
    await Promise.resolve();
    expect(onNavigate).toHaveBeenLastCalledWith("workspace", "right");
  });

  it("owns two-finger movement before nested one-finger handlers can consume it", async () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminal = screen.getByTestId("terminal-surface");
    const nestedMove = vi.fn();
    terminal.addEventListener("touchmove", nestedMove);
    dispatchTouch(terminal, "touchstart", [touch(1, 180, 80), touch(2, 220, 120)]);
    const move = dispatchTouch(terminal, "touchmove", [touch(1, 110, 82), touch(2, 150, 122)]);
    dispatchTouch(terminal, "touchend", []);
    await Promise.resolve();

    expect(move.defaultPrevented).toBe(true);
    expect(nestedMove).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("terminal", "left");
  });

  it("claims terminal multi-touch before nested movement is consumed", () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminalInput = screen.getByTestId("terminal-fit-host");
    const onClaim = vi.fn();
    terminalInput.addEventListener(TERMINAL_MULTI_TOUCH_CLAIM_EVENT, onClaim);
    dispatchTouch(terminalInput, "touchstart", [touch(1, 180, 80)]);
    dispatchTouch(terminalInput, "touchstart", [touch(1, 180, 80), touch(2, 220, 120)]);

    expect(onClaim).toHaveBeenCalledOnce();
  });

  it("completes before xterm-style document touch-end consumption", async () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const consumeTouchEnd = (event: TouchEvent) => event.stopPropagation();
    document.addEventListener("touchend", consumeTouchEnd);

    try {
      const terminal = screen.getByTestId("terminal-surface");
      dispatchTouch(terminal, "touchstart", [touch(1, 180, 80), touch(2, 220, 120)]);
      dispatchTouch(terminal, "touchmove", [touch(1, 110, 82), touch(2, 150, 122)]);
      dispatchTouch(terminal, "touchend", []);
      await Promise.resolve();

      expect(onNavigate).toHaveBeenCalledWith("terminal", "left");
    } finally {
      document.removeEventListener("touchend", consumeTouchEnd);
    }
  });

  it("navigates after nested touch-end handlers finish and pending sensors release", async () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminal = screen.getByTestId("terminal-surface");
    const nestedEnd = vi.fn();
    terminal.addEventListener("touchend", nestedEnd);
    dispatchTouch(terminal, "touchstart", [touch(1, 180, 80), touch(2, 220, 120)]);
    dispatchTouch(terminal, "touchmove", [touch(1, 110, 82), touch(2, 150, 122)]);
    const firstEnd = dispatchTouch(terminal, "touchend", [touch(2, 150, 122)]);

    expect(firstEnd.defaultPrevented).toBe(false);
    expect(nestedEnd).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();

    const finalEnd = dispatchTouch(terminal, "touchend", []);

    expect(finalEnd.defaultPrevented).toBe(false);
    expect(nestedEnd).toHaveBeenCalledTimes(2);
    expect(onNavigate).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(onNavigate).toHaveBeenCalledWith("terminal", "left");
  });

  it("keeps the first finger surface when the second finger lands elsewhere", async () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);

    const terminal = screen.getByTestId("terminal-surface");
    const workspace = screen.getByTestId("workspace-surface");
    dispatchTouch(terminal, "touchstart", [touch(1, 180, 80)]);
    const secondStart = dispatchTouch(workspace, "touchstart", [
      touch(1, 180, 80),
      touch(2, 220, 120),
    ]);
    dispatchTouch(workspace, "touchmove", [touch(1, 110, 82), touch(2, 150, 122)]);
    dispatchTouch(workspace, "touchend", []);
    await Promise.resolve();

    expect(secondStart.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("terminal", "left");
  });
});
