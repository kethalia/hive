import {
  computeSmartTiledLayout,
  type SmartTiledLayout,
  type TiledPane,
  type TiledPaneInput,
} from "@/lib/workspaces/tiled-layout";

export const SESSION_PANE_LAYOUT_VERSION = 1;

export const FLOATING_PANE_MIN_WIDTH = 320;
export const FLOATING_PANE_MIN_HEIGHT = 220;
export const FLOATING_PANE_DEFAULT_WIDTH = 720;
export const FLOATING_PANE_DEFAULT_HEIGHT = 420;
export const FLOATING_PANE_CASCADE_INSET = 24;
export const FLOATING_PANE_CASCADE_OFFSET = 36;
export const FLOATING_PANE_Z_INDEX_BASE = 100;

export type SessionPaneMode = "tiled" | "floating";

export interface SessionPaneContainerRect {
  width?: number | null;
  height?: number | null;
}

export interface FloatingPaneGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export interface PersistedSessionPane {
  sessionName: string;
  mode: SessionPaneMode;
  order?: number;
  geometry?: Partial<FloatingPaneGeometry> | null;
}

export interface PersistedSessionPaneLayout {
  version: typeof SESSION_PANE_LAYOUT_VERSION;
  panes: PersistedSessionPane[];
}

export interface SessionPaneLayoutDiagnostic {
  code:
    | "container-invalid"
    | "persisted-json-invalid"
    | "persisted-version-unsupported"
    | "persisted-layout-malformed"
    | "stale-pane-dropped"
    | "pane-geometry-repaired";
  message: string;
  sessionName?: string;
  count?: number;
}

export interface TiledSessionPane extends TiledPane {
  mode: "tiled";
}

export interface FloatingSessionPane {
  id: string;
  sessionName: string;
  label: string;
  order: number;
  mode: "floating";
  testId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export type SessionPane = TiledSessionPane | FloatingSessionPane;

export interface SessionPaneLayout {
  version: typeof SESSION_PANE_LAYOUT_VERSION;
  panes: SessionPane[];
  tiled: SmartTiledLayout;
  diagnostics: SessionPaneLayoutDiagnostic[];
}

export interface ResolveSessionPaneLayoutOptions {
  sessions: readonly TiledPaneInput[];
  persistedJson?: string | null;
  container?: SessionPaneContainerRect | null;
}

export type PersistedSessionPaneLayoutParseResult =
  | { status: "unavailable"; layout: null; diagnostics: SessionPaneLayoutDiagnostic[] }
  | {
      status: "valid";
      layout: PersistedSessionPaneLayout;
      diagnostics: SessionPaneLayoutDiagnostic[];
    }
  | { status: "invalid"; layout: null; diagnostics: SessionPaneLayoutDiagnostic[] };

interface SafeContainerRect {
  width: number;
  height: number;
}

interface GeometryRepairResult {
  geometry: FloatingPaneGeometry;
  repaired: boolean;
}

export function resolveSessionPaneLayout({
  sessions,
  persistedJson,
  container,
}: ResolveSessionPaneLayoutOptions): SessionPaneLayout {
  const baseLayout = computeSmartTiledLayout(sessions);
  const diagnostics: SessionPaneLayoutDiagnostic[] = [];
  const parsed = parsePersistedSessionPaneLayout(persistedJson);
  diagnostics.push(...parsed.diagnostics);

  const safeContainer = coerceContainer(container);
  if (!safeContainer && persistedJson) {
    diagnostics.push({
      code: "container-invalid",
      message: "Floating pane geometry was ignored because the workspace container is unavailable.",
    });
  }

  const currentSessionNames = new Set(baseLayout.panes.map((pane) => pane.sessionName));
  const persistedBySessionName = new Map<string, PersistedSessionPane>();

  if (parsed.status === "valid") {
    let staleCount = 0;
    for (const pane of parsed.layout.panes) {
      const sessionName = normalizeSessionName(pane.sessionName);
      if (!sessionName) continue;
      if (!currentSessionNames.has(sessionName)) {
        staleCount += 1;
        continue;
      }
      if (!persistedBySessionName.has(sessionName)) {
        persistedBySessionName.set(sessionName, { ...pane, sessionName });
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

  const modeBySessionName = new Map<string, SessionPaneMode>();
  for (const pane of baseLayout.panes) {
    const persistedPane = persistedBySessionName.get(pane.sessionName);
    const mode = persistedPane?.mode === "floating" && safeContainer ? "floating" : "tiled";
    modeBySessionName.set(pane.sessionName, mode);
  }

  return buildSessionPaneLayout({
    basePanes: baseLayout.panes,
    modeForPane: (pane) => modeBySessionName.get(pane.sessionName) ?? "tiled",
    geometryForPane: (pane) => persistedBySessionName.get(pane.sessionName)?.geometry,
    container: safeContainer,
    diagnostics,
  });
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
  const panes = layout.panes.map((pane): PersistedSessionPane => {
    if (pane.mode === "floating") {
      return {
        sessionName: pane.sessionName,
        mode: "floating",
        order: pane.order,
        geometry: {
          x: pane.x,
          y: pane.y,
          width: pane.width,
          height: pane.height,
          zIndex: pane.zIndex,
        },
      };
    }

    return {
      sessionName: pane.sessionName,
      mode: "tiled",
      order: pane.order,
    };
  });

  return JSON.stringify({
    version: SESSION_PANE_LAYOUT_VERSION,
    panes,
  } satisfies PersistedSessionPaneLayout);
}

export function createCascadedFloatingGeometry(
  order: number,
  container?: SessionPaneContainerRect | null,
): FloatingPaneGeometry {
  const safeContainer = coerceContainer(container) ?? {
    width: FLOATING_PANE_DEFAULT_WIDTH + FLOATING_PANE_CASCADE_INSET * 2,
    height: FLOATING_PANE_DEFAULT_HEIGHT + FLOATING_PANE_CASCADE_INSET * 2,
  };
  const width = clampDimension(
    FLOATING_PANE_DEFAULT_WIDTH,
    FLOATING_PANE_MIN_WIDTH,
    Math.max(1, safeContainer.width - FLOATING_PANE_CASCADE_INSET * 2),
  );
  const height = clampDimension(
    FLOATING_PANE_DEFAULT_HEIGHT,
    FLOATING_PANE_MIN_HEIGHT,
    Math.max(1, safeContainer.height - FLOATING_PANE_CASCADE_INSET * 2),
  );
  const maxX = Math.max(0, safeContainer.width - width);
  const maxY = Math.max(0, safeContainer.height - height);
  const cascadeSlotsX = Math.max(1, Math.floor(maxX / FLOATING_PANE_CASCADE_OFFSET) + 1);
  const cascadeSlotsY = Math.max(1, Math.floor(maxY / FLOATING_PANE_CASCADE_OFFSET) + 1);
  const slotCount = Math.max(1, Math.min(cascadeSlotsX, cascadeSlotsY));
  const slot = Math.max(0, Math.trunc(order)) % slotCount;

  return {
    x: clampPosition(FLOATING_PANE_CASCADE_INSET + slot * FLOATING_PANE_CASCADE_OFFSET, maxX),
    y: clampPosition(FLOATING_PANE_CASCADE_INSET + slot * FLOATING_PANE_CASCADE_OFFSET, maxY),
    width,
    height,
    zIndex: FLOATING_PANE_Z_INDEX_BASE + Math.max(0, Math.trunc(order)),
  };
}

export function bumpSessionPaneZIndex(
  layout: SessionPaneLayout,
  sessionName: string,
): SessionPaneLayout {
  const maxZIndex = layout.panes.reduce((max, pane) => {
    if (pane.mode !== "floating") return max;
    return Math.max(max, pane.zIndex);
  }, FLOATING_PANE_Z_INDEX_BASE - 1);
  const nextZIndex = maxZIndex + 1;

  return {
    ...layout,
    panes: layout.panes.map((pane) => {
      if (pane.mode !== "floating" || pane.sessionName !== sessionName) return pane;
      return { ...pane, zIndex: nextZIndex };
    }),
  };
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

  return buildSessionPaneLayout({
    basePanes,
    modeForPane: () => "tiled",
    geometryForPane: () => undefined,
    container: null,
    diagnostics,
  });
}

function buildSessionPaneLayout({
  basePanes,
  modeForPane,
  geometryForPane,
  container,
  diagnostics,
}: {
  basePanes: TiledPane[];
  modeForPane: (pane: TiledPane) => SessionPaneMode;
  geometryForPane: (pane: TiledPane) => Partial<FloatingPaneGeometry> | null | undefined;
  container: SafeContainerRect | null;
  diagnostics: SessionPaneLayoutDiagnostic[];
}): SessionPaneLayout {
  const tiledBasePanes = basePanes.filter((pane) => modeForPane(pane) === "tiled");
  const tiledLayout = computeSmartTiledLayout(
    tiledBasePanes.map((pane) => ({ sessionName: pane.sessionName, label: pane.label })),
  );
  const tiledGeometryByOrder = new Map<number, TiledPane>();
  tiledBasePanes.forEach((basePane, index) => {
    const tiledPane = tiledLayout.panes[index];
    if (tiledPane) tiledGeometryByOrder.set(basePane.order, tiledPane);
  });

  const panes: SessionPane[] = basePanes.map((basePane) => {
    if (modeForPane(basePane) === "floating" && container) {
      const repair = repairFloatingGeometry(geometryForPane(basePane), basePane.order, container);
      if (repair.repaired) {
        diagnostics.push({
          code: "pane-geometry-repaired",
          message: "Floating pane geometry was repaired to fit the current workspace container.",
          sessionName: basePane.sessionName,
        });
      }
      return {
        id: basePane.id,
        sessionName: basePane.sessionName,
        label: basePane.label,
        order: basePane.order,
        mode: "floating",
        testId: basePane.testId,
        ...repair.geometry,
      };
    }

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

  const tiledPanes = panes.filter((pane): pane is TiledSessionPane => pane.mode === "tiled");

  return {
    version: SESSION_PANE_LAYOUT_VERSION,
    panes,
    tiled: {
      ...tiledLayout,
      panes: tiledPanes,
    },
    diagnostics,
  };
}

function repairFloatingGeometry(
  persistedGeometry: Partial<FloatingPaneGeometry> | null | undefined,
  order: number,
  container: SafeContainerRect,
): GeometryRepairResult {
  const fallback = createCascadedFloatingGeometry(order, container);
  const raw = isRecord(persistedGeometry) ? persistedGeometry : {};
  const requestedWidth = finiteNumberOrUndefined(raw.width) ?? fallback.width;
  const requestedHeight = finiteNumberOrUndefined(raw.height) ?? fallback.height;
  const width = clampDimension(requestedWidth, FLOATING_PANE_MIN_WIDTH, container.width);
  const height = clampDimension(requestedHeight, FLOATING_PANE_MIN_HEIGHT, container.height);
  const maxX = Math.max(0, container.width - width);
  const maxY = Math.max(0, container.height - height);
  const requestedX = finiteNumberOrUndefined(raw.x) ?? fallback.x;
  const requestedY = finiteNumberOrUndefined(raw.y) ?? fallback.y;
  const requestedZIndex = finiteNumberOrUndefined(raw.zIndex) ?? fallback.zIndex;
  const geometry = {
    x: clampPosition(requestedX, maxX),
    y: clampPosition(requestedY, maxY),
    width,
    height,
    zIndex: Math.max(FLOATING_PANE_Z_INDEX_BASE, Math.trunc(requestedZIndex)),
  };

  return {
    geometry,
    repaired:
      geometry.x !== requestedX ||
      geometry.y !== requestedY ||
      geometry.width !== requestedWidth ||
      geometry.height !== requestedHeight ||
      geometry.zIndex !== requestedZIndex ||
      !isCompleteGeometry(raw),
  };
}

function coerceContainer(container?: SessionPaneContainerRect | null): SafeContainerRect | null {
  if (!container) return null;
  const width = finiteNumberOrUndefined(container.width);
  const height = finiteNumberOrUndefined(container.height);
  if (!width || !height || width <= 0 || height <= 0) return null;
  return { width, height };
}

function clampDimension(value: number, min: number, max: number): number {
  const safeMax = Math.max(1, Math.trunc(max));
  const safeMin = Math.min(Math.trunc(min), safeMax);
  return Math.min(Math.max(Math.trunc(value), safeMin), safeMax);
}

function clampPosition(value: number, max: number): number {
  return Math.min(Math.max(0, Math.trunc(value)), Math.max(0, Math.trunc(max)));
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

function isCompleteGeometry(value: Record<string, unknown>): boolean {
  return (
    finiteNumberOrUndefined(value.x) !== undefined &&
    finiteNumberOrUndefined(value.y) !== undefined &&
    finiteNumberOrUndefined(value.width) !== undefined &&
    finiteNumberOrUndefined(value.height) !== undefined &&
    finiteNumberOrUndefined(value.zIndex) !== undefined
  );
}
