import { describe, expect, it } from "vitest";
import {
  deriveResetSessionPaneLayout,
  deriveRetiledSessionPaneLayout,
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

  it("uses persisted pane order while coercing stale floating metadata back to tiled panes", () => {
    const persisted = JSON.stringify({
      version: SESSION_PANE_LAYOUT_VERSION,
      panes: [
        {
          sessionName: "old-session",
          mode: "floating",
          order: 0,
          geometry: { x: 10, y: 20, width: 640, height: 400, zIndex: 77 },
        },
        {
          sessionName: "api",
          mode: "floating",
          order: 1,
          geometry: { x: 12, y: 24, width: 650, height: 410, zIndex: 12 },
        },
        { sessionName: "new-session", mode: "tiled", order: 0 },
      ],
    });

    const layout = resolveSessionPaneLayout({
      sessions: ["api", "new-session"],
      persistedJson: persisted,
      container,
    });

    expect(layout.panes.map((pane) => [pane.sessionName, pane.mode, pane.order])).toEqual([
      ["new-session", "tiled", 0],
      ["api", "tiled", 1],
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

  it("resets and retiles every pane to tiled mode after stale floating metadata", () => {
    const layout = resolveSessionPaneLayout({
      sessions: ["api", "worker"],
      persistedJson: JSON.stringify({
        version: SESSION_PANE_LAYOUT_VERSION,
        panes: [
          {
            sessionName: "api",
            mode: "floating",
            order: 1,
            geometry: { x: -999, y: -999, width: 1, height: 1, zIndex: 1 },
          },
          {
            sessionName: "worker",
            mode: "floating",
            order: 0,
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
    expect(retiled.panes.map((pane) => pane.sessionName)).toEqual(["worker", "api"]);
    expect(retiled.panes.map((pane) => (pane.mode === "tiled" ? pane.gridArea : null))).toEqual([
      "1 / 1 / span 1 / span 1",
      "1 / 2 / span 1 / span 1",
    ]);
  });

  it("serializes only versioned order metadata needed to restore pane layout", () => {
    const layout = resolveSessionPaneLayout({
      sessions: [{ sessionName: "api", label: "secret terminal text should not persist" }],
      persistedJson: JSON.stringify({
        version: SESSION_PANE_LAYOUT_VERSION,
        panes: [
          {
            sessionName: "api",
            mode: "floating",
            order: 0,
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
          mode: "tiled",
          order: 0,
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
