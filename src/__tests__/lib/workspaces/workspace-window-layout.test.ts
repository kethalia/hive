import { describe, expect, it } from "vitest";
import {
  computeWorkspaceWindowRects,
  emptyWorkspaceWindowLayoutState,
  findWorkspaceWindowInDirection,
  parseWorkspaceWindowLayoutState,
  reconcileWorkspaceWindowLayout,
  serializeWorkspaceWindowLayoutState,
  swapWorkspaceWindows,
  workspaceWindowIds,
} from "@/lib/workspaces/workspace-window-layout";

describe("workspace window layout", () => {
  it("splits a landscape window on the y axis and a portrait window on the x axis", () => {
    const landscape = reconcileWorkspaceWindowLayout(null, ["main", "build"], {
      focusedWindowId: "main",
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    const portrait = reconcileWorkspaceWindowLayout(null, ["main", "build"], {
      focusedWindowId: "main",
      viewportWidth: 800,
      viewportHeight: 1200,
    });

    expect(landscape).toMatchObject({ type: "split", axis: "y" });
    expect(portrait).toMatchObject({ type: "split", axis: "x" });
  });

  it("splits the focused leaf in half without moving the other windows", () => {
    const initial = reconcileWorkspaceWindowLayout(null, ["main", "build"], {
      focusedWindowId: "main",
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    const next = reconcileWorkspaceWindowLayout(initial, ["main", "build", "logs"], {
      focusedWindowId: "main",
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    const rects = computeWorkspaceWindowRects(next);

    expect(rects.get("build")).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(rects.get("main")).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(rects.get("logs")).toEqual({ x: 0, y: 0.5, width: 0.5, height: 0.5 });
  });

  it("collapses removed leaves and keeps every remaining window inside a gapless viewport", () => {
    const initial = reconcileWorkspaceWindowLayout(null, ["one", "two", "three", "four"], {
      viewportWidth: 1600,
      viewportHeight: 900,
    });
    const next = reconcileWorkspaceWindowLayout(initial, ["one", "three", "four"], {
      viewportWidth: 1600,
      viewportHeight: 900,
    });
    const rects = computeWorkspaceWindowRects(next);

    expect(next ? workspaceWindowIds(next) : []).toEqual(["one", "three", "four"]);
    expect([...rects.values()].reduce((total, rect) => total + rect.width * rect.height, 0)).toBe(
      1,
    );
    for (const rect of rects.values()) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1);
    }
  });

  it("swaps dragged windows without changing the split geometry", () => {
    const initial = reconcileWorkspaceWindowLayout(null, ["main", "build", "logs"], {
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    expect(initial).not.toBeNull();
    if (!initial) return;

    const before = computeWorkspaceWindowRects(initial);
    const swapped = swapWorkspaceWindows(initial, "main", "logs");
    const after = computeWorkspaceWindowRects(swapped);

    expect(after.get("main")).toEqual(before.get("logs"));
    expect(after.get("logs")).toEqual(before.get("main"));
    expect(workspaceWindowIds(swapped)).toEqual(["logs", "build", "main"]);
  });

  it("finds the closest window in the requested direction and never wraps at an edge", () => {
    const rects = new Map([
      ["left", { x: 0, y: 0, width: 0.5, height: 1 }],
      ["top-right", { x: 0.5, y: 0, width: 0.5, height: 0.5 }],
      ["bottom-right", { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }],
    ]);

    expect(findWorkspaceWindowInDirection(rects, "bottom-right", "up")).toBe("top-right");
    expect(findWorkspaceWindowInDirection(rects, "bottom-right", "left")).toBe("left");
    expect(findWorkspaceWindowInDirection(rects, "left", "right")).toBe("bottom-right");
    expect(findWorkspaceWindowInDirection(rects, "left", "left")).toBeNull();
    expect(findWorkspaceWindowInDirection(rects, "top-right", "up")).toBeNull();
  });

  it("does not treat a narrower window sharing an outer edge as a side neighbor", () => {
    const rects = new Map([
      ["wide-top", { x: 0, y: 0, width: 0.5, height: 0.5 }],
      ["narrow-bottom-left", { x: 0, y: 0.5, width: 0.25, height: 0.5 }],
      ["narrow-bottom-right", { x: 0.25, y: 0.5, width: 0.25, height: 0.5 }],
    ]);

    expect(findWorkspaceWindowInDirection(rects, "wide-top", "left")).toBeNull();
    expect(findWorkspaceWindowInDirection(rects, "narrow-bottom-left", "left")).toBeNull();
    expect(findWorkspaceWindowInDirection(rects, "narrow-bottom-left", "up")).toBe("wide-top");
  });

  it("round-trips valid persisted trees and safely rejects corrupt state", () => {
    const root = reconcileWorkspaceWindowLayout(null, ["main", "build"], {
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    expect(root).not.toBeNull();
    if (!root) return;

    const state = { ...emptyWorkspaceWindowLayoutState(), boards: [{ boardKey: "main", root }] };
    expect(parseWorkspaceWindowLayoutState(serializeWorkspaceWindowLayoutState(state))).toEqual(
      state,
    );
    expect(parseWorkspaceWindowLayoutState("{broken")).toEqual(emptyWorkspaceWindowLayoutState());
    expect(
      parseWorkspaceWindowLayoutState(
        JSON.stringify({ version: 99, boards: [{ boardKey: "main", root }] }),
      ),
    ).toEqual(emptyWorkspaceWindowLayoutState());
  });
});
