// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowCanvas } from "@/components/workspaces/WindowCanvas";
import type { GeneralBoard } from "@/lib/workspaces/general-workspace";
import { newWindowManager, type WindowColumn } from "@/lib/workspaces/window-manager";

function column(id: string, windows: string[], pin?: WindowColumn["pin"]): WindowColumn {
  return { id, windows, pin, width: 1, tabbed: false, weights: {} };
}
function board(columns: WindowColumn[], active: string): GeneralBoard {
  return {
    key: "board",
    name: "1",
    order: 0,
    activeWindowId: active,
    manager: { ...newWindowManager(), columns },
    windows: columns
      .flatMap((column) => column.windows)
      .map((id) => ({
        id,
        kind: "terminal",
        label: id,
        workspaceId: "software",
        sessionName: id,
      })),
  };
}
function Harness({ initial, height = 600 }: { initial: GeneralBoard; height?: number }) {
  const [current, setCurrent] = useState(initial);
  return (
    <>
      <output data-testid="active">{current.activeWindowId}</output>
      <button
        type="button"
        onClick={() =>
          setCurrent((current) => ({
            ...current,
            manager: { ...current.manager!, scroll: 40 },
          }))
        }
      >
        Scroll Strip horizontally
      </button>
      <WindowCanvas
        boards={[current]}
        activeBoardKey="board"
        width={390}
        height={height}
        mobile
        onBoardChange={(_key, change) => setCurrent(change)}
        onActivate={(_key, id) => setCurrent((current) => ({ ...current, activeWindowId: id }))}
        renderPane={(_board, pane) => <div data-testid={`pane-${pane.id}`}>{pane.label}</div>}
      />
    </>
  );
}
async function swipe(direction: "left" | "right") {
  const id = screen.getByTestId("active").textContent;
  const target = screen.getByTestId(`pane-${id}`);
  await act(async () => {
    for (const [type, touches] of [
      ["touchstart", [{ identifier: 1, clientX: 160, clientY: 220 }]],
      ["touchmove", [{ identifier: 1, clientX: direction === "left" ? 80 : 240, clientY: 220 }]],
      ["touchend", []],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      target.dispatchEvent(event);
    }
    await Promise.resolve();
  });
}
function scroller(container: HTMLElement) {
  const element = container.querySelector<HTMLDivElement>('[data-mobile-scroll-allow="true"]');
  if (!element) throw new Error("Missing canvas scroller");
  return element;
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mobile canvas navigation", () => {
  it("reveals every window in a vertically overflowing Strip stack in both directions", async () => {
    const { container } = render(
      <Harness initial={board([column("stack", ["a", "b", "c", "d", "e"])], "a")} />,
    );
    const canvas = scroller(container);
    expect(canvas.scrollTop).toBe(0);
    for (const [id, top] of [
      ["b", 0],
      ["c", 0],
      ["d", 40],
      ["e", 200],
    ] as const) {
      await swipe("left");
      expect(screen.getByTestId("active").textContent).toBe(id);
      expect(canvas.scrollTop).toBe(top);
    }
    for (const id of ["d", "c", "b", "a"]) {
      await swipe("right");
      expect(screen.getByTestId("active").textContent).toBe(id);
    }
    expect(canvas.scrollTop).toBe(0);
    expect(canvas.scrollLeft).toBe(0);
  });

  it("keeps the selected stacked window visible when the keyboard shrinks the canvas", async () => {
    const initial = board([column("stack", ["a", "b", "c", "d", "e"])], "e");
    const { container, rerender } = render(<Harness initial={initial} />);
    const canvas = scroller(container);
    expect(canvas.scrollTop).toBe(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    rerender(<Harness initial={initial} height={400} />);
    expect(canvas.scrollTop).toBe(400);
  });

  it("preserves manual vertical scrolling while panning Strip horizontally", async () => {
    const { container } = render(
      <Harness
        initial={board(
          [column("stack", ["a", "b", "c", "d", "e"]), column("neighbor", ["f"])],
          "a",
        )}
      />,
    );
    const canvas = scroller(container);
    canvas.scrollTop = 200;
    await act(async () =>
      screen.getByRole("button", { name: "Scroll Strip horizontally" }).click(),
    );
    expect(canvas.scrollTop).toBe(200);
  });

  it.each([
    { pin: "left" as const, start: "b", next: ["a", "c"] },
    { pin: "right" as const, start: "a", next: ["c", "b"] },
  ])("follows visual order with the middle column pinned $pin", async ({ pin, start, next }) => {
    render(
      <Harness
        initial={board([column("a", ["a"]), column("b", ["b"], pin), column("c", ["c"])], start)}
      />,
    );
    await swipe("right");
    expect(screen.getByTestId("active").textContent).toBe(start);
    for (const id of next) {
      await swipe("left");
      expect(screen.getByTestId("active").textContent).toBe(id);
    }
    await swipe("left");
    expect(screen.getByTestId("active").textContent).toBe(next.at(-1));
    for (const id of [next[0], start]) {
      await swipe("right");
      expect(screen.getByTestId("active").textContent).toBe(id);
    }
  });
});
