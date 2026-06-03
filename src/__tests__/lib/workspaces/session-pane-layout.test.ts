import { describe, expect, it } from "vitest";
import {
  bumpSessionPaneZIndex,
  createCascadedFloatingGeometry,
  deriveResetSessionPaneLayout,
  deriveRetiledSessionPaneLayout,
  FLOATING_PANE_DEFAULT_HEIGHT,
  FLOATING_PANE_DEFAULT_WIDTH,
  FLOATING_PANE_MIN_HEIGHT,
  FLOATING_PANE_MIN_WIDTH,
  parsePersistedSessionPaneLayout,
  resolveSessionPaneLayout,
  SESSION_PANE_LAYOUT_VERSION,
  serializeSessionPaneLayout,
} from "@/lib/workspaces/session-pane-layout";

const container = { width: 1200, height: 800 };

describe("session pane layout model", () => {
  it("resolves current sessions in deterministic input order and reuses smart tiled geometry", () => {
    const layout = resolveSessionPaneLayout({
      sessions: [{ sessionName: "worker" }, { sessionName: "api" }, { sessionName: "shell" }],
      container,
    });

    expect(layout.version).toBe(SESSION_PANE_LAYOUT_VERSION);
    expect(layout.panes.map((pane) => [pane.sessionName, pane.mode, pane.order])).toEqual([
      ["worker", "tiled", 0],
      ["api", "tiled", 1],
      ["shell", "tiled", 2],
    ]);
    expect(layout.tiled.rows).toBe(2);
    expect(layout.tiled.columns).toBe(2);
    expect(layout.panes.map((pane) => (pane.mode === "tiled" ? pane.gridArea : null))).toEqual([
      "1 / 1 / span 1 / span 1",
      "1 / 2 / span 1 / span 1",
      "2 / 1 / span 1 / span 1",
    ]);
    expect(layout.diagnostics).toEqual([]);
  });

  it("drops stale stored panes and keeps new sessions tiled by default", () => {
    const persisted = JSON.stringify({
      version: SESSION_PANE_LAYOUT_VERSION,
      panes: [
        {
          sessionName: "old-session",
          mode: "floating",
          geometry: { x: 10, y: 20, width: 640, height: 400, zIndex: 77 },
        },
        {
          sessionName: "api",
          mode: "floating",
          geometry: { x: 12, y: 24, width: 650, height: 410, zIndex: 12 },
        },
      ],
    });

    const layout = resolveSessionPaneLayout({
      sessions: ["api", "new-session"],
      persistedJson: persisted,
      container,
    });

    expect(layout.panes.map((pane) => [pane.sessionName, pane.mode])).toEqual([
      ["api", "floating"],
      ["new-session", "tiled"],
    ]);
    expect(layout.diagnostics.map((diagnostic) => diagnostic.code)).toContain("stale-pane-dropped");
    expect(layout.panes.find((pane) => pane.sessionName === "old-session")).toBeUndefined();
  });

  it("falls back to safe tiled layout for corrupt JSON and wrong persisted versions", () => {
    const corrupt = resolveSessionPaneLayout({
      sessions: ["api", "worker"],
      persistedJson: "{not-json",
      container,
    });
    const wrongVersion = resolveSessionPaneLayout({
      sessions: ["api", "worker"],
      persistedJson: JSON.stringify({ version: 999, panes: [] }),
      container,
    });

    expect(corrupt.panes.map((pane) => pane.mode)).toEqual(["tiled", "tiled"]);
    expect(corrupt.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "persisted-json-invalid",
    );
    expect(wrongVersion.panes.map((pane) => pane.mode)).toEqual(["tiled", "tiled"]);
    expect(wrongVersion.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "persisted-version-unsupported",
    );
    expect(() => parsePersistedSessionPaneLayout("{not-json")).not.toThrow();
  });

  it("cascades default floating geometry within a valid container", () => {
    const first = createCascadedFloatingGeometry(0, container);
    const second = createCascadedFloatingGeometry(1, container);
    const wrapped = createCascadedFloatingGeometry(50, container);

    expect(first).toEqual({
      x: 24,
      y: 24,
      width: FLOATING_PANE_DEFAULT_WIDTH,
      height: FLOATING_PANE_DEFAULT_HEIGHT,
      zIndex: 100,
    });
    expect(second).toMatchObject({ x: 60, y: 60, zIndex: 101 });
    expect(wrapped.x).toBeGreaterThanOrEqual(24);
    expect(wrapped.y).toBeGreaterThanOrEqual(24);
    expect(wrapped.x + wrapped.width).toBeLessThanOrEqual(container.width);
    expect(wrapped.y + wrapped.height).toBeLessThanOrEqual(container.height);
  });

  it("repairs malformed floating geometry with min/max clamping", () => {
    const layout = resolveSessionPaneLayout({
      sessions: ["api"],
      persistedJson: JSON.stringify({
        version: SESSION_PANE_LAYOUT_VERSION,
        panes: [
          {
            sessionName: "api",
            mode: "floating",
            geometry: { x: -500, y: Number.NaN, width: 10, height: 9999, zIndex: -4 },
          },
        ],
      }),
      container: { width: 500, height: 300 },
    });

    const pane = layout.panes[0];
    expect(pane.mode).toBe("floating");
    if (pane.mode !== "floating") throw new Error("expected floating pane");
    expect(pane.x).toBeGreaterThanOrEqual(0);
    expect(pane.y).toBeGreaterThanOrEqual(0);
    expect(pane.width).toBe(FLOATING_PANE_MIN_WIDTH);
    expect(pane.height).toBe(300);
    expect(pane.width).toBeGreaterThanOrEqual(FLOATING_PANE_MIN_WIDTH);
    expect(pane.height).toBeGreaterThanOrEqual(FLOATING_PANE_MIN_HEIGHT);
    expect(pane.zIndex).toBeGreaterThanOrEqual(100);
    expect(layout.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "pane-geometry-repaired",
    );
  });

  it("uses safe tiled fallback dimensions when the container is zero or missing", () => {
    const missing = resolveSessionPaneLayout({
      sessions: ["api"],
      persistedJson: JSON.stringify({
        version: SESSION_PANE_LAYOUT_VERSION,
        panes: [
          {
            sessionName: "api",
            mode: "floating",
            geometry: { x: 40, y: 40, width: 640, height: 400, zIndex: 120 },
          },
        ],
      }),
    });
    const zero = resolveSessionPaneLayout({
      sessions: ["api"],
      persistedJson: JSON.stringify({ version: SESSION_PANE_LAYOUT_VERSION, panes: [] }),
      container: { width: 0, height: 0 },
    });

    expect(missing.panes[0].mode).toBe("tiled");
    expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain("container-invalid");
    expect(zero.panes[0].mode).toBe("tiled");
    expect(zero.diagnostics.map((diagnostic) => diagnostic.code)).toContain("container-invalid");
  });

  it("bumps a floating pane above existing z-index values without changing order", () => {
    const layout = resolveSessionPaneLayout({
      sessions: ["api", "worker"],
      persistedJson: JSON.stringify({
        version: SESSION_PANE_LAYOUT_VERSION,
        panes: [
          {
            sessionName: "api",
            mode: "floating",
            geometry: { x: 10, y: 10, width: 500, height: 300, zIndex: 105 },
          },
          {
            sessionName: "worker",
            mode: "floating",
            geometry: { x: 20, y: 20, width: 500, height: 300, zIndex: 140 },
          },
        ],
      }),
      container,
    });

    const bumped = bumpSessionPaneZIndex(layout, "api");

    expect(bumped.panes.map((pane) => pane.sessionName)).toEqual(["api", "worker"]);
    const api = bumped.panes.find((pane) => pane.sessionName === "api");
    expect(api?.mode).toBe("floating");
    if (!api || api.mode !== "floating") throw new Error("expected floating api pane");
    expect(api.zIndex).toBe(141);
  });

  it("resets and retiles every pane to tiled mode after bad geometry", () => {
    const layout = resolveSessionPaneLayout({
      sessions: ["api", "worker"],
      persistedJson: JSON.stringify({
        version: SESSION_PANE_LAYOUT_VERSION,
        panes: [
          {
            sessionName: "api",
            mode: "floating",
            geometry: { x: -999, y: -999, width: 1, height: 1, zIndex: 1 },
          },
          {
            sessionName: "worker",
            mode: "floating",
            geometry: { x: 200, y: 100, width: 900, height: 700, zIndex: 2 },
          },
        ],
      }),
      container,
    });

    const reset = deriveResetSessionPaneLayout(layout);
    const retiled = deriveRetiledSessionPaneLayout(layout);

    expect(reset.panes.map((pane) => pane.mode)).toEqual(["tiled", "tiled"]);
    expect(retiled.panes.map((pane) => pane.mode)).toEqual(["tiled", "tiled"]);
    expect(retiled.panes.map((pane) => (pane.mode === "tiled" ? pane.gridArea : null))).toEqual([
      "1 / 1 / span 1 / span 1",
      "1 / 2 / span 1 / span 1",
    ]);
  });

  it("serializes only versioned metadata needed to restore pane layout", () => {
    const layout = resolveSessionPaneLayout({
      sessions: [{ sessionName: "api", label: "secret terminal text should not persist" }],
      persistedJson: JSON.stringify({
        version: SESSION_PANE_LAYOUT_VERSION,
        panes: [
          {
            sessionName: "api",
            mode: "floating",
            geometry: { x: 10, y: 20, width: 640, height: 400, zIndex: 120 },
            clipboard: "do-not-persist",
            terminalBuffer: "do-not-persist",
            cwd: "/secret/path",
          },
        ],
      }),
      container,
    });

    const serialized = serializeSessionPaneLayout(layout);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual({
      version: SESSION_PANE_LAYOUT_VERSION,
      panes: [
        {
          sessionName: "api",
          mode: "floating",
          order: 0,
          geometry: { x: 10, y: 20, width: 640, height: 400, zIndex: 120 },
        },
      ],
    });
    expect(serialized).not.toMatch(/secret terminal|clipboard|terminalBuffer|cwd|do-not-persist/);
  });

  it("skips blank session names while preserving stable ids for duplicate and slug-colliding sessions", () => {
    const layout = resolveSessionPaneLayout({
      sessions: ["Main", "  ", "main", "main!", "main"],
      container,
    });

    expect(layout.panes.map((pane) => pane.sessionName)).toEqual(["Main", "main", "main!", "main"]);
    expect(layout.panes.map((pane) => pane.id)).toEqual([
      "pane-main",
      "pane-main-2",
      "pane-main-3",
      "pane-main-4",
    ]);
    expect(new Set(layout.panes.map((pane) => pane.id)).size).toBe(layout.panes.length);
  });
});
