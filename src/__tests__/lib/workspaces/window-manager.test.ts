import { describe, expect, it } from "vitest";
import {
  emptyGeneralWorkspace,
  type GeneralBoard,
  moveGeneralWindowToNextBoard,
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
  it("moves a pane without duplicating a target that already exists on the next board", () => {
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
    const next = moveGeneralWindowToNextBoard(state, "unused");
    expect(next.activeBoardKey).toBe("other");
    expect(next.boards[0].windows).toBe(source.windows);
    expect(next.boards[1].windows).toBe(target.windows);
    expect(
      parseGeneralWorkspace(JSON.stringify(next))?.boards.map((b) => b.windows.length),
    ).toEqual([3, 1]);
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
  it("keeps tiles above minimum sizes even in a crowded grid", () => {
    const b = board("grid");
    const g = windowGeometry(b.manager!, b.layout, ["a", "b", "c"], "a", 400, 220);
    expect([...g.rects.values()].every((r) => r.width >= 280 && r.height >= 160)).toBe(true);
    expect(g.width).toBeGreaterThan(400);
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
    "ctrl+alt",
    "ctrl+cmd",
  ] as const)("has no ambiguous bindings in the %s preset", (preset) => {
    const keys = WINDOW_ACTIONS.flatMap((a) => windowActionKeys(a, preset));
    expect(new Set(keys).size).toBe(keys.length);
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
