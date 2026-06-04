import {
  computeSmartTiledLayout,
  type SmartTiledLayout,
  type TiledPane,
  type TiledPaneInput,
} from "@/lib/workspaces/tiled-layout";

export const SESSION_PANE_LAYOUT_VERSION = 1;

type PersistedSessionPaneMode = "tiled" | "floating";

export interface PersistedSessionPane {
  sessionName: string;
  /**
   * Legacy persisted floating metadata is accepted for migration, but M004 renders panes tiled-only.
   */
  mode: PersistedSessionPaneMode;
  order?: number;
  geometry?: Record<string, unknown> | null;
}

export interface PersistedSessionPaneLayout {
  version: typeof SESSION_PANE_LAYOUT_VERSION;
  panes: PersistedSessionPane[];
}

export interface SessionPaneLayoutDiagnostic {
  code:
    | "persisted-json-invalid"
    | "persisted-version-unsupported"
    | "persisted-layout-malformed"
    | "stale-pane-dropped";
  message: string;
  sessionName?: string;
  count?: number;
}

export interface TiledSessionPane extends TiledPane {
  mode: "tiled";
}

export type SessionPane = TiledSessionPane;

export interface SessionPaneLayout {
  version: typeof SESSION_PANE_LAYOUT_VERSION;
  panes: SessionPane[];
  tiled: SmartTiledLayout;
  diagnostics: SessionPaneLayoutDiagnostic[];
}

export interface ResolveSessionPaneLayoutOptions {
  sessions: readonly TiledPaneInput[];
  persistedJson?: string | null;
}

export type PersistedSessionPaneLayoutParseResult =
  | { status: "unavailable"; layout: null; diagnostics: SessionPaneLayoutDiagnostic[] }
  | {
      status: "valid";
      layout: PersistedSessionPaneLayout;
      diagnostics: SessionPaneLayoutDiagnostic[];
    }
  | { status: "invalid"; layout: null; diagnostics: SessionPaneLayoutDiagnostic[] };

export function resolveSessionPaneLayout({
  sessions,
  persistedJson,
}: ResolveSessionPaneLayoutOptions): SessionPaneLayout {
  const diagnostics: SessionPaneLayoutDiagnostic[] = [];
  const parsed = parsePersistedSessionPaneLayout(persistedJson);
  diagnostics.push(...parsed.diagnostics);

  const orderedSessions = applyPersistedPaneOrder(
    sessions,
    parsed.status === "valid" ? parsed.layout.panes : [],
  );
  const baseLayout = computeSmartTiledLayout(orderedSessions);
  const currentSessionNames = new Set(baseLayout.panes.map((pane) => pane.sessionName));

  if (parsed.status === "valid") {
    let staleCount = 0;
    for (const pane of parsed.layout.panes) {
      const sessionName = normalizeSessionName(pane.sessionName);
      if (!sessionName) continue;
      if (!currentSessionNames.has(sessionName)) {
        staleCount += 1;
      }
    }
    if (staleCount > 0) {
      diagnostics.push({
        code: "stale-pane-dropped",
        message: "Stored panes for sessions that are no longer present were dropped.",
        count: staleCount,
      });
    }
  }

  return buildTiledSessionPaneLayout(baseLayout.panes, diagnostics);
}

function applyPersistedPaneOrder(
  sessions: readonly TiledPaneInput[],
  persistedPanes: readonly PersistedSessionPane[],
): TiledPaneInput[] {
  if (persistedPanes.length === 0) return [...sessions];

  const orderBySessionName = new Map<string, number>();
  persistedPanes.forEach((pane, index) => {
    const sessionName = normalizeSessionName(pane.sessionName);
    if (!sessionName || orderBySessionName.has(sessionName)) return;
    orderBySessionName.set(sessionName, finiteNumberOrUndefined(pane.order) ?? index);
  });

  const originalIndexBySessionName = new Map<string, number>();
  sessions.forEach((session, index) => {
    const sessionName = sessionNameFromTiledInput(session);
    if (!sessionName || originalIndexBySessionName.has(sessionName)) return;
    originalIndexBySessionName.set(sessionName, index);
  });

  return [...sessions].sort((left, right) => {
    const leftSessionName = sessionNameFromTiledInput(left);
    const rightSessionName = sessionNameFromTiledInput(right);
    const leftOrder = orderBySessionName.get(leftSessionName) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderBySessionName.get(rightSessionName) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return (
      (originalIndexBySessionName.get(leftSessionName) ?? Number.MAX_SAFE_INTEGER) -
      (originalIndexBySessionName.get(rightSessionName) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function sessionNameFromTiledInput(input: TiledPaneInput): string {
  return normalizeSessionName(
    typeof input === "string" ? input : (input.sessionName ?? input.name),
  );
}

export function parsePersistedSessionPaneLayout(
  persistedJson?: string | null,
): PersistedSessionPaneLayoutParseResult {
  if (typeof persistedJson !== "string" || persistedJson.trim().length === 0) {
    return { status: "unavailable", layout: null, diagnostics: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(persistedJson);
  } catch {
    return {
      status: "invalid",
      layout: null,
      diagnostics: [
        {
          code: "persisted-json-invalid",
          message: "Stored pane layout JSON could not be parsed; safe tiled layout was used.",
        },
      ],
    };
  }

  if (!isRecord(parsed)) {
    return {
      status: "invalid",
      layout: null,
      diagnostics: [
        {
          code: "persisted-layout-malformed",
          message: "Stored pane layout was not an object; safe tiled layout was used.",
        },
      ],
    };
  }

  if (parsed.version !== SESSION_PANE_LAYOUT_VERSION) {
    return {
      status: "invalid",
      layout: null,
      diagnostics: [
        {
          code: "persisted-version-unsupported",
          message: "Stored pane layout version is unsupported; safe tiled layout was used.",
        },
      ],
    };
  }

  if (!Array.isArray(parsed.panes)) {
    return {
      status: "invalid",
      layout: null,
      diagnostics: [
        {
          code: "persisted-layout-malformed",
          message: "Stored pane layout panes were malformed; safe tiled layout was used.",
        },
      ],
    };
  }

  const panes: PersistedSessionPane[] = [];
  for (const pane of parsed.panes) {
    if (!isRecord(pane)) continue;
    const sessionName = normalizeSessionName(pane.sessionName);
    if (!sessionName) continue;
    panes.push({
      sessionName,
      mode: pane.mode === "floating" ? "floating" : "tiled",
      order: finiteNumberOrUndefined(pane.order),
      geometry: isRecord(pane.geometry) ? pane.geometry : undefined,
    });
  }

  return {
    status: "valid",
    layout: {
      version: SESSION_PANE_LAYOUT_VERSION,
      panes,
    },
    diagnostics: [],
  };
}

export function serializeSessionPaneLayout(layout: SessionPaneLayout): string {
  const panes = layout.panes.map(
    (pane): PersistedSessionPane => ({
      sessionName: pane.sessionName,
      mode: "tiled",
      order: pane.order,
    }),
  );

  return JSON.stringify({
    version: SESSION_PANE_LAYOUT_VERSION,
    panes,
  } satisfies PersistedSessionPaneLayout);
}

export function deriveResetSessionPaneLayout(layout: SessionPaneLayout): SessionPaneLayout {
  return deriveAllTiledLayout(layout, [...layout.diagnostics]);
}

export function deriveRetiledSessionPaneLayout(layout: SessionPaneLayout): SessionPaneLayout {
  return deriveAllTiledLayout(layout, [...layout.diagnostics]);
}

function deriveAllTiledLayout(
  layout: SessionPaneLayout,
  diagnostics: SessionPaneLayoutDiagnostic[],
): SessionPaneLayout {
  const basePanes = computeSmartTiledLayout(
    layout.panes.map((pane) => ({ sessionName: pane.sessionName, label: pane.label })),
  ).panes;

  return buildTiledSessionPaneLayout(basePanes, diagnostics);
}

function buildTiledSessionPaneLayout(
  basePanes: TiledPane[],
  diagnostics: SessionPaneLayoutDiagnostic[],
): SessionPaneLayout {
  const tiledLayout = computeSmartTiledLayout(
    basePanes.map((pane) => ({ sessionName: pane.sessionName, label: pane.label })),
  );
  const tiledGeometryByOrder = new Map<number, TiledPane>();
  basePanes.forEach((basePane, index) => {
    const tiledPane = tiledLayout.panes[index];
    if (tiledPane) tiledGeometryByOrder.set(basePane.order, tiledPane);
  });

  const panes = basePanes.map((basePane): TiledSessionPane => {
    const tiledPane = tiledGeometryByOrder.get(basePane.order) ?? basePane;
    return {
      ...basePane,
      row: tiledPane.row,
      column: tiledPane.column,
      rowSpan: tiledPane.rowSpan,
      columnSpan: tiledPane.columnSpan,
      gridArea: tiledPane.gridArea,
      mode: "tiled",
    };
  });

  return {
    version: SESSION_PANE_LAYOUT_VERSION,
    panes,
    tiled: {
      ...tiledLayout,
      panes,
    },
    diagnostics,
  };
}

function normalizeSessionName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
