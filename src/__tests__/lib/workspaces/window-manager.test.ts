import { describe, expect, it } from "vitest";
import { PANE_CONTROL_SHORTCUTS } from "@/lib/keyboard-shortcuts";
import {
  emptyGeneralWorkspace,
  type GeneralBoard,
  moveGeneralWindowToAdjacentBoard,
  parseGeneralWorkspace,
} from "@/lib/workspaces/general-workspace";
import { openNotificationWindow } from "@/lib/workspaces/notification-window";
import {
  applyWindowAction,
  WINDOW_ACTIONS,
  windowActionKeys,
} from "@/lib/workspaces/window-actions";
import {
  detachColumn,
  joinColumn,
  newWindowManager,
  reconcileWindowManager,
  revealWindow,
  windowGeometry,
  windowManagerSchema,
} from "@/lib/workspaces/window-manager";
import {
  reconcileWorkspaceWindowLayout,
  resizeWorkspaceSplit,
} from "@/lib/workspaces/workspace-window-layout";

function board(mode: "grid" | "strip" = "strip"): GeneralBoard {
  const ids = ["a", "b", "c"];
  return {
    key: "main",
    name: "1",
    order: 0,
    activeWindowId: "a",
    windows: ids.map((id) => ({
      id,
      workspaceId: "software",
      kind: "terminal",
      label: id,
      sessionName: id,
    })),
    manager: reconcileWindowManager(newWindowManager(mode), ids),
    layout:
      reconcileWorkspaceWindowLayout(undefined, ids, {
        viewportWidth: 1200,
        viewportHeight: 800,
      }) ?? undefined,
  };
}
describe("window layouts", () => {
  it("cycles all desktop width presets and wraps without changing neighboring columns", () => {
    let b = board();
    const initial = b.manager!.columns.slice(1);
    for (const expected of [2 / 3, 0.75, 1, 0.25, 1 / 3, 0.5]) {
      b = applyWindowAction(b, "cycle-width", 1440, 800);
      expect(b.manager!.columns[0].width).toBeCloseTo(expected);
      expect(b.manager!.columns.slice(1)).toEqual(initial);
    }
  });

  it.each([
    390, 744, 1194,
  ])("cycles visible sizes and keeps the last pane in view at %spx", (width) => {
    let b = board();
    b.activeWindowId = "c";
    const ids = b.windows.map((w) => w.id);
    let previous = windowGeometry(b.manager!, b.layout, ids, "c", width, 800).rects.get("c")!.width;
    for (let step = 0; step < 8; step++) {
      b = applyWindowAction(b, "cycle-width", width, 800);
      const rect = windowGeometry(b.manager!, b.layout, ids, "c", width, 800).rects.get("c")!;
      expect(Math.abs(rect.width - previous)).toBeGreaterThan(1);
      expect(rect.x).toBeGreaterThanOrEqual(-1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      previous = rect.width;
    }
  });

  it("cycles floating widths through the usable presets", () => {
    let b = applyWindowAction(board(), "float", 390, 800);
    for (const expected of [0.75, 1, 280 / 390]) {
      b = applyWindowAction(b, "cycle-width", 390, 800);
      expect(b.manager!.floating.a.width).toBeCloseTo(expected);
    }
  });

  it.each([
    390, 744, 1194,
  ])("offers an inward-facing leading grip for the last Strip column at %spx", (width) => {
    const b = board();
    const m = b.manager!;
    m.scroll = 100000;
    const geometry = windowGeometry(m, b.layout, ["a", "b", "c"], "c", width, 800);
    const handle = geometry.dividers.find(
      (d) => d.target.kind === "column" && d.target.id === m.columns[2].id && d.edge === "start",
    );
    expect(handle).toBeDefined();
    expect(handle!.extent).toBeLessThan(0);
    const pane = geometry.rects.get("c")!;
    expect(handle!.rect.x).toBe(pane.x);
    const previous = geometry.dividers.find(
      (d) => d.target.kind === "column" && d.target.id === m.columns[1].id,
    );
    expect(previous!.rect.x + previous!.rect.width).toBeLessThanOrEqual(handle!.rect.x);
    expect(pane.x).toBeGreaterThanOrEqual(0);
    expect(pane.x + pane.width).toBeCloseTo(width);
    expect(handle!.value - 40 / handle!.extent).toBeGreaterThan(handle!.value);
  });
  it("equalizes a Grid with only vertical splits", () => {
    const b = board("grid");
    b.layout = {
      type: "split",
      axis: "x",
      ratio: 0.7,
      first: { type: "leaf", id: "a" },
      second: { type: "leaf", id: "b" },
    };
    const next = applyWindowAction(b, "equalize", 1000, 800);
    expect(next.layout).toMatchObject({ ratio: 0.5 });
  });
  it.each([
    -1, 1,
  ] as const)("preserves both clients when moving %s to an existing target", (direction) => {
    const source = board();
    const target = {
      ...board(),
      key: "other",
      windows: [{ ...source.windows[0], id: "already-open" }],
      activeWindowId: "already-open",
    };
    const state = {
      ...emptyGeneralWorkspace(),
      activeBoardKey: source.key,
      boards: [source, target],
    };
    const next = moveGeneralWindowToAdjacentBoard(state, "unused", direction);
    expect(next.activeBoardKey).toBe("other");
    expect(next.boards[0].windows).toBe(source.windows);
    expect(next.boards[1].windows).toBe(target.windows);
    expect(
      parseGeneralWorkspace(JSON.stringify(next))?.boards.map((b) => b.windows.length),
    ).toEqual([3, 1]);
  });
  it.each([
    -1, 1,
  ] as const)("moves %s across three boards and wraps without changing pane identity", (direction) => {
    const source = board();
    const others: GeneralBoard[] = ["second", "third"].map((key, index) => ({
      key,
      name: key,
      order: index + 1,
      windows: [],
    }));
    const initial = {
      ...emptyGeneralWorkspace(),
      activeBoardKey: source.key,
      boards: [source, ...others],
    };
    let current = initial;
    const destinations =
      direction === 1 ? ["second", "third", "main"] : ["third", "second", "main"];
    for (const key of destinations) {
      current = moveGeneralWindowToAdjacentBoard(current, "unused", direction);
      expect(current.activeBoardKey).toBe(key);
      const target = current.boards.find((b) => b.key === key)!;
      expect(target.activeWindowId).toBe("a");
      expect(target.windows.find((w) => w.id === "a")).toBe(source.windows[0]);
      expect(current.boards.flatMap((b) => b.windows).filter((w) => w.id === "a")).toHaveLength(1);
    }
    expect(initial.boards[0].windows).toHaveLength(3);
  });
  it.each([
    -1, 1,
  ] as const)("creates one destination for a sole board when moving %s", (direction) => {
    const source = board();
    const initial = { ...emptyGeneralWorkspace(), activeBoardKey: source.key, boards: [source] };
    const moved = moveGeneralWindowToAdjacentBoard(initial, "new-board", direction);
    expect(moved.boards).toHaveLength(2);
    expect(moved.activeBoardKey).toBe("new-board");
    expect(moved.boards[1].windows).toEqual([source.windows[0]]);
    const empty = emptyGeneralWorkspace();
    expect(moveGeneralWindowToAdjacentBoard(empty, "unused", direction)).toBe(empty);
  });
  it("preserves old grids and validates persisted dimensions without losing windows", () => {
    const state = emptyGeneralWorkspace();
    state.boards = [board("grid")];
    state.activeBoardKey = "main";
    state.boards[0].layout = resizeWorkspaceSplit(state.boards[0].layout!, "", 0.7);
    const restored = parseGeneralWorkspace(JSON.stringify(state))!;
    expect(restored.boards[0].layout).toEqual(state.boards[0].layout);
    expect(restored.boards[0].windows).toEqual(state.boards[0].windows);
    delete state.boards[0].manager;
    expect(parseGeneralWorkspace(JSON.stringify(state))?.boards[0].manager?.mode).toBe("grid");
  });
  it.each([
    [320, 180],
    [390, 740],
    [744, 400],
    [1440, 900],
  ])("fits every Grid tile in a %s × %s viewport and leaves room to resize", (width, height) => {
    for (const count of [3, 6, 12]) {
      const ids = Array.from({ length: count }, (_, index) => `window-${index}`);
      const root = reconcileWorkspaceWindowLayout(undefined, ids, {
        viewportWidth: 1200,
        viewportHeight: 800,
      })!;
      const original = JSON.stringify(root);
      const manager = reconcileWindowManager(newWindowManager("grid"), ids);
      const check = (layout: typeof root) => {
        const geometry = windowGeometry(manager, layout, ids, ids[0], width, height);
        expect(geometry.width).toBe(width);
        expect(geometry.height).toBe(height);
        expect(geometry.rects.size).toBe(count);
        let area = 0;
        for (const rect of geometry.rects.values()) {
          expect(rect.x).toBeGreaterThanOrEqual(-0.001);
          expect(rect.y).toBeGreaterThanOrEqual(-0.001);
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(width + 0.001);
          expect(rect.y + rect.height).toBeLessThanOrEqual(height + 0.001);
          area += rect.width * rect.height;
        }
        expect(area).toBeCloseTo(width * height);
        return geometry;
      };
      const geometry = check(root);
      for (const divider of geometry.dividers) {
        expect(divider.max - divider.min).toBeGreaterThan(0.01);
        if (divider.target.kind !== "grid") throw new Error("Expected a Grid boundary");
        check(resizeWorkspaceSplit(root, divider.target.path, divider.min));
        check(resizeWorkspaceSplit(root, divider.target.path, divider.max));
      }
      expect(JSON.stringify(root)).toBe(original);
    }
  });
  it("scrolls to focus without shrinking existing strip columns", () => {
    const b = board(),
      next = applyWindowAction(b, "window-3", 1000, 700);
    expect(next.manager?.columns.map((c) => c.width)).toEqual(
      b.manager?.columns.map((c) => c.width),
    );
    expect(next.manager?.scroll).toBeGreaterThan(0);
    const r = windowGeometry(next.manager!, next.layout, ["a", "b", "c"], "c", 1000, 700).rects.get(
      "c",
    )!;
    expect(r.x + r.width).toBeLessThanOrEqual(1000);
  });
  it("returns to the adjacent column after right, right, left with fractional widths", () => {
    let current = board();
    const widths = [0.55, 0.65, 0.5];
    current.manager!.columns.forEach((column, index) => {
      column.width = widths[index];
    });
    for (const [action, expected] of [
      ["focus-right", "b"],
      ["focus-right", "c"],
      ["focus-left", "b"],
      ["focus-left", "a"],
    ]) {
      current = applyWindowAction(current, action, 1440, 800);
      expect(current.activeWindowId).toBe(expected);
    }
  });
  it.each([
    false,
    true,
  ])("reveals from the clamped offset after a column closes (center: %s)", (center) => {
    const ids = ["a", "b", "c", "d"];
    let manager = reconcileWindowManager(newWindowManager(), ids);
    manager.scroll = 1200;
    manager = reconcileWindowManager(manager, ["a", "b", "d"]);
    const geometry = windowGeometry(manager, undefined, ["a", "b", "d"], "d", 1200, 800);
    expect(geometry.maxScroll).toBe(600);
    manager = revealWindow(manager, geometry, "a", 1200, center);
    expect(manager.scroll).toBe(0);
    const revealed = windowGeometry(manager, undefined, ["a", "b", "d"], "a", 1200, 800).rects.get(
      "a",
    )!;
    expect(revealed.x).toBe(0);
  });
  it("stacks, tabs and detaches without duplicate pane or column identities", () => {
    let m = joinColumn(board().manager!, "a", 1);
    expect(m.columns[0].windows).toEqual(["b", "a"]);
    m = detachColumn(m, "b", 1);
    expect(new Set(m.columns.map((c) => c.id)).size).toBe(m.columns.length);
    expect(m.columns.flatMap((c) => c.windows).sort()).toEqual(["a", "b", "c"]);
    const b = { ...board(), manager: joinColumn(board().manager!, "a", 1) };
    const tabbed = applyWindowAction(b, "tabs", 1000, 700);
    const g = windowGeometry(tabbed.manager!, b.layout, ["a", "b", "c"], "a", 1000, 700);
    expect(g.hidden.has("b")).toBe(true);
    expect(g.hidden.has("a")).toBe(false);
    const mobile = windowGeometry(tabbed.manager!, b.layout, ["a", "b", "c"], "a", 390, 700, {
      showColumnTabs: false,
    });
    expect(mobile.tabs).toEqual([]);
    expect(mobile.hidden.has("b")).toBe(true);
    expect(mobile.rects.get("a")).toMatchObject({ y: 0, height: 700 });
    expect(applyWindowAction(tabbed, "focus-up", 1000, 700).activeWindowId).toBe("b");
  });
  it.each([
    undefined,
    "left",
    "right",
  ] as const)("preserves an activated tab after focus leaves a column pinned %s and after reload", (pin) => {
    const b = board();
    b.manager = joinColumn(b.manager!, "b", -1);
    b.manager.columns[0] = { ...b.manager.columns[0], tabbed: true, selected: "a", pin };
    b.manager = revealWindow(
      b.manager,
      windowGeometry(b.manager, b.layout, ["a", "b", "c"], "b", 1200, 800),
      "b",
      1200,
    );
    b.activeWindowId = "b";
    const next = applyWindowAction(b, "window-3", 1200, 800);
    const restored = parseGeneralWorkspace(
      JSON.stringify({ ...emptyGeneralWorkspace(), activeBoardKey: b.key, boards: [next] }),
    )!.boards[0];
    expect(restored.manager!.columns[0].selected).toBe("b");
    const geometry = windowGeometry(
      restored.manager!,
      restored.layout,
      ["a", "b", "c"],
      "c",
      1200,
      800,
    );
    expect(geometry.hidden.has("a")).toBe(true);
    expect(geometry.hidden.has("b")).toBe(false);
  });
  it.each([
    "focus-down",
    "window-2",
  ])("persists tab selection through keyboard action %s before focusing another column", (action) => {
    const b = board();
    b.manager = joinColumn(b.manager!, "b", -1);
    b.manager.columns[0] = { ...b.manager.columns[0], tabbed: true, selected: "a" };
    const selected = applyWindowAction(b, action, 1200, 800);
    expect(selected.activeWindowId).toBe("b");
    const next = applyWindowAction(selected, "focus-right", 1200, 800);
    expect(next.activeWindowId).toBe("c");
    const geometry = windowGeometry(next.manager!, next.layout, ["a", "b", "c"], "c", 1200, 800);
    expect(geometry.hidden.has("a")).toBe(true);
    expect(geometry.hidden.has("b")).toBe(false);
  });
  it("represents a stacked divider as the proportion between two neighbors", () => {
    const b = board();
    const m = joinColumn(b.manager!, "b", -1);
    m.columns[0].weights = { a: 3, b: 1 };
    const divider = windowGeometry(m, b.layout, ["a", "b", "c"], "a", 1200, 800).dividers.find(
      (d) => d.target.kind === "stack",
    );
    expect(divider?.value).toBe(0.75);
    expect(divider?.extent).toBe(800 - 2 * 160);
  });
  it("moves focus while keeping Grid maximization on the newly focused window", () => {
    const b = applyWindowAction(board("grid"), "maximize", 1200, 800);
    const next = applyWindowAction(b, "focus-right", 1200, 800);
    expect(next.activeWindowId).not.toBe("a");
    expect(next.manager?.maximized).toBe(next.activeWindowId);
  });
  it("transfers Grid maximization when revealing another pane", () => {
    const b = applyWindowAction(board("grid"), "maximize", 1200, 800);
    const manager = revealWindow(
      b.manager!,
      windowGeometry(b.manager!, b.layout, ["a", "b", "c"], "b", 1200, 800),
      "b",
      1200,
    );
    const geometry = windowGeometry(manager, b.layout, ["a", "b", "c"], "b", 1200, 800);
    expect(manager.maximized).toBe("b");
    expect(geometry.hidden.has("b")).toBe(false);
    expect(geometry.rects.get("b")).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });
  it.each([
    { action: "wider", axis: "y", outer: "x", active: "a", ratio: 0.55 },
    { action: "wider", axis: "y", outer: "x", active: "b", ratio: 0.45 },
    { action: "taller", axis: "x", outer: "y", active: "a", ratio: 0.55 },
    { action: "taller", axis: "x", outer: "y", active: "b", ratio: 0.45 },
  ] as const)("$action resizes only the split adjacent to $active", ({
    action,
    axis,
    outer,
    active,
    ratio,
  }) => {
    const b = board("grid");
    b.windows.push({
      kind: "terminal",
      workspaceId: "software",
      id: "d",
      label: "d",
      sessionName: "d",
    });
    b.activeWindowId = active;
    b.layout = {
      type: "split",
      axis: outer,
      ratio: 0.5,
      first: {
        type: "split",
        axis,
        ratio: 0.5,
        first: { type: "leaf", id: "a" },
        second: { type: "leaf", id: "b" },
      },
      second: {
        type: "split",
        axis,
        ratio: 0.5,
        first: { type: "leaf", id: "c" },
        second: { type: "leaf", id: "d" },
      },
    };
    const next = applyWindowAction(b, action, 1200, 800);
    expect(next.layout).toMatchObject({ first: { ratio }, second: { ratio: 0.5 } });
  });
  it("uses visible Grid geometry after leaving a tabbed Strip arrangement", () => {
    let b = board();
    b.windows = b.windows.slice(0, 2);
    b.layout = {
      type: "split",
      axis: "x",
      first: { type: "leaf", id: "a" },
      second: { type: "leaf", id: "b" },
    };
    b.manager = reconcileWindowManager(b.manager, ["a", "b"]);
    b = applyWindowAction(b, "join-right", 600, 900);
    b = applyWindowAction(b, "tabs", 600, 900);
    expect(b.manager!.columns[0].windows).toEqual(["b", "a"]);
    b = applyWindowAction(b, "grid", 600, 900);
    expect(applyWindowAction(b, "focus-down", 600, 900).activeWindowId).toBe("b");
  });
  it("bounds small floating windows and repairs duplicate column IDs on restore", () => {
    const m = board().manager!;
    m.columns[1].id = m.columns[0].id;
    m.floating.c = { x: 0.99, y: 0.99, width: 0.05, height: 0.05 };
    const repaired = reconcileWindowManager(m, ["a", "b", "c"]);
    expect(new Set(repaired.columns.map((c) => c.id)).size).toBe(2);
    const r = windowGeometry(repaired, undefined, ["a", "b", "c"], "a", 800, 600).rects.get("c")!;
    expect(r.x + r.width).toBeLessThanOrEqual(800);
    expect(r.y + r.height).toBeLessThanOrEqual(600);
  });
  it("pins one column per side and keeps pinned geometry stationary", () => {
    let b = applyWindowAction(board(), "pin-left", 1000, 700);
    b = applyWindowAction(b, "window-3", 1000, 700);
    const g = windowGeometry(b.manager!, b.layout, ["a", "b", "c"], "c", 1000, 700);
    expect(g.rects.get("a")?.x).toBe(0);
    b = applyWindowAction(b, "pin-left", 1000, 700);
    expect(b.manager?.columns.filter((c) => c.pin === "left")).toHaveLength(1);
  });
  it("round-trips floating dimensions and returns a window to tiling", () => {
    let b = applyWindowAction(board(), "float", 1000, 700);
    b.manager!.floating.a.x = 0.01;
    const restored = parseGeneralWorkspace(
      JSON.stringify({ version: 1, activeBoardKey: "main", boards: [b] }),
    )!;
    expect(restored.boards[0].manager?.floating.a.x).toBe(0.01);
    b = applyWindowAction(b, "float", 1000, 700);
    expect(b.manager?.floating.a).toBeUndefined();
    expect(b.manager?.columns.flatMap((c) => c.windows).filter((id) => id === "a")).toHaveLength(1);
  });
  it.each([
    false,
    true,
  ])("has no ambiguous or combined primary modifiers (macOS: %s)", (isApple) => {
    const keys = [
      ...WINDOW_ACTIONS.flatMap((a) => windowActionKeys(a, "primary+alt", isApple)),
      ...Object.values(PANE_CONTROL_SHORTCUTS).flatMap((a) =>
        a.keys.filter((key) => (isApple ? key.startsWith("cmd+") : key.startsWith("ctrl+"))),
      ),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => !key.includes(isApple ? "ctrl" : "cmd"))).toBe(true);
    expect(keys).toContain(`${isApple ? "cmd" : "ctrl"}+arrowright`);
  });
  it.each([
    "ctrl+alt",
    "ctrl+cmd",
  ])("migrates saved %s bindings without losing the layout", (shortcuts) => {
    const manager = newWindowManager();
    expect(windowManagerSchema.parse({ ...manager, shortcuts })).toEqual(manager);
    expect(windowManagerSchema.parse({ ...manager, shortcuts: "off" }).shortcuts).toBe("off");
  });
});
describe("notification windows", () => {
  it("focuses an existing window on any board without replacing its descriptor", () => {
    const b = board(),
      state = {
        ...emptyGeneralWorkspace(),
        boards: [b, { ...board(), key: "other", windows: [] }],
      };
    state.activeBoardKey = "other";
    const next = openNotificationWindow(state, b.windows[1], "unused");
    expect(next.boards).toHaveLength(2);
    expect(next.activeBoardKey).toBe("main");
    expect(next.boards[0].activeWindowId).toBe("b");
    expect(next.boards[0].windows[1]).toBe(b.windows[1]);
  });
  it("creates a new board for a missing window and never matches another Coder workspace", () => {
    const b = board(),
      state = { ...emptyGeneralWorkspace(), boards: [b], activeBoardKey: b.key };
    const pane = { ...b.windows[0], workspaceId: "browser" };
    const next = openNotificationWindow(state, pane, "new");
    expect(next.boards).toHaveLength(2);
    expect(next.boards[0].windows).toBe(b.windows);
    expect(next.boards[1].windows[0].workspaceId).toBe("browser");
  });
  it("does not evict windows or boards at the limit", () => {
    const b = board(),
      state = {
        ...emptyGeneralWorkspace(),
        boards: Array.from({ length: 9 }, (_, i) => ({ ...b, key: `${i}` })),
      };
    expect(() =>
      openNotificationWindow(state, { ...b.windows[0], workspaceId: "other" }, "new"),
    ).toThrow("Close an unused board");
  });
});
