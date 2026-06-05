import { describe, expect, it } from "vitest";
import { computeSmartTiledLayout } from "@/lib/workspaces/tiled-layout";

describe("computeSmartTiledLayout", () => {
  it("returns an empty tiled grid for empty input", () => {
    expect(computeSmartTiledLayout([])).toEqual({
      layoutMode: "tiled",
      panes: [],
      rows: 0,
      columns: 0,
      gridTemplateColumns: "none",
      gridTemplateRows: "none",
    });
  });

  it("creates a one pane grid for one session", () => {
    const layout = computeSmartTiledLayout([{ sessionName: "main" }]);

    expect(layout).toEqual({
      layoutMode: "tiled",
      panes: [
        {
          id: "pane-main",
          sessionName: "main",
          label: "main",
          order: 0,
          row: 1,
          column: 1,
          rowSpan: 1,
          columnSpan: 1,
          gridArea: "1 / 1 / span 1 / span 1",
          testId: "terminal-pane-main",
        },
      ],
      rows: 1,
      columns: 1,
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: "minmax(0, 1fr)",
    });
  });

  it("places two sessions side by side", () => {
    const layout = computeSmartTiledLayout([{ sessionName: "api" }, { sessionName: "worker" }]);

    expect(layout.rows).toBe(1);
    expect(layout.columns).toBe(2);
    expect(layout.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(layout.gridTemplateRows).toBe("minmax(0, 1fr)");
    expect(
      layout.panes.map((pane) => [pane.sessionName, pane.row, pane.column, pane.gridArea]),
    ).toEqual([
      ["api", 1, 1, "1 / 1 / span 1 / span 1"],
      ["worker", 1, 2, "1 / 2 / span 1 / span 1"],
    ]);
  });

  it("places three sessions with the primary pane spanning the full left column", () => {
    const layout = computeSmartTiledLayout([
      { sessionName: "worker" },
      { sessionName: "api" },
      { sessionName: "shell" },
    ]);

    expect(layout.rows).toBe(2);
    expect(layout.columns).toBe(2);
    expect(
      layout.panes.map((pane) => [
        pane.sessionName,
        pane.row,
        pane.column,
        pane.rowSpan,
        pane.columnSpan,
        pane.gridArea,
      ]),
    ).toEqual([
      ["worker", 1, 1, 2, 1, "1 / 1 / span 2 / span 1"],
      ["api", 1, 2, 1, 1, "1 / 2 / span 1 / span 1"],
      ["shell", 2, 2, 1, 1, "2 / 2 / span 1 / span 1"],
    ]);
  });

  it("places four sessions in a balanced two by two grid", () => {
    const layout = computeSmartTiledLayout(["zeta", "alpha", "delta", "beta"]);

    expect(layout.rows).toBe(2);
    expect(layout.columns).toBe(2);
    expect(layout.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(layout.gridTemplateRows).toBe("repeat(2, minmax(0, 1fr))");
    expect(layout.panes.map((pane) => [pane.sessionName, pane.row, pane.column])).toEqual([
      ["zeta", 1, 1],
      ["alpha", 1, 2],
      ["delta", 2, 1],
      ["beta", 2, 2],
    ]);
  });

  it("keeps larger session counts deterministic without floating geometry", () => {
    const layout = computeSmartTiledLayout(["s07", "s01", "s06", "s02", "s05", "s03", "s04"]);

    expect(layout.rows).toBe(3);
    expect(layout.columns).toBe(3);
    expect(layout.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(layout.gridTemplateRows).toBe("repeat(3, minmax(0, 1fr))");
    expect(layout.panes.map((pane) => [pane.sessionName, pane.row, pane.column])).toEqual([
      ["s07", 1, 1],
      ["s01", 1, 2],
      ["s06", 1, 3],
      ["s02", 2, 1],
      ["s05", 2, 2],
      ["s03", 2, 3],
      ["s04", 3, 1],
    ]);
    expect(JSON.stringify(layout)).not.toMatch(/"(?:x|y|width|height)"/);
  });

  it("skips blank names and supports tmux session shaped objects", () => {
    const layout = computeSmartTiledLayout([
      { name: "  main  ", created: 1, windows: 1 },
      { sessionName: "   " },
      "",
      " dev ",
    ]);

    expect(layout.panes.map((pane) => pane.sessionName)).toEqual(["main", "dev"]);
  });

  it("assigns stable unique pane ids for duplicate names and slug collisions", () => {
    const first = computeSmartTiledLayout(["Main", "main", "main!", "main"]);
    const second = computeSmartTiledLayout(["Main", "main", "main!", "main"]);

    expect(first.panes.map((pane) => pane.id)).toEqual([
      "pane-main",
      "pane-main-2",
      "pane-main-3",
      "pane-main-4",
    ]);
    expect(new Set(first.panes.map((pane) => pane.id)).size).toBe(first.panes.length);
    expect(second.panes.map((pane) => pane.id)).toEqual(first.panes.map((pane) => pane.id));
    expect(first.panes.map((pane) => pane.testId)).toEqual([
      "terminal-pane-main",
      "terminal-pane-main-2",
      "terminal-pane-main-3",
      "terminal-pane-main-4",
    ]);
  });

  it("uses explicit labels while keeping pane identity tied to the session name", () => {
    const layout = computeSmartTiledLayout([{ sessionName: "build", label: "Build logs" }]);

    expect(layout.panes[0]).toMatchObject({
      id: "pane-build",
      sessionName: "build",
      label: "Build logs",
    });
  });
});
