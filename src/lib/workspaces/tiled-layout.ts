export type TiledPaneInput =
  | string
  | {
      sessionName?: string;
      name?: string;
      label?: string;
      [key: string]: unknown;
    };

interface NormalizedTiledPaneInput {
  sessionName: string;
  label: string;
}

export interface TiledPane {
  id: string;
  sessionName: string;
  label: string;
  order: number;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  gridArea: string;
  testId: string;
}

export interface SmartTiledLayout {
  layoutMode: "tiled";
  panes: TiledPane[];
  rows: number;
  columns: number;
  gridTemplateColumns: string;
  gridTemplateRows: string;
}

export function computeSmartTiledLayout(inputs: readonly TiledPaneInput[]): SmartTiledLayout {
  const normalized = normalizePaneInputs(inputs);
  const columns = normalized.length > 0 ? Math.ceil(Math.sqrt(normalized.length)) : 0;
  const rows = columns > 0 ? Math.ceil(normalized.length / columns) : 0;
  const slugCounts = new Map<string, number>();

  const panes = normalized.map((input, order) => {
    const row = Math.floor(order / columns) + 1;
    const column = (order % columns) + 1;
    const baseId = `pane-${slugifyPaneId(input.sessionName)}`;
    const occurrence = (slugCounts.get(baseId) ?? 0) + 1;
    slugCounts.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;

    return {
      id,
      sessionName: input.sessionName,
      label: input.label,
      order,
      row,
      column,
      rowSpan: 1,
      columnSpan: 1,
      gridArea: `${row} / ${column} / span 1 / span 1`,
      testId: `terminal-${id}`,
    };
  });

  return {
    layoutMode: "tiled",
    panes,
    rows,
    columns,
    gridTemplateColumns: buildGridTemplate(columns),
    gridTemplateRows: buildGridTemplate(rows),
  };
}

function normalizePaneInputs(inputs: readonly TiledPaneInput[]): NormalizedTiledPaneInput[] {
  const normalized: NormalizedTiledPaneInput[] = [];

  for (const input of inputs) {
    const rawSessionName =
      typeof input === "string" ? input : (input.sessionName ?? input.name ?? "");
    const sessionName = rawSessionName.trim();
    if (sessionName.length === 0) continue;

    const rawLabel = typeof input === "string" ? input : (input.label ?? sessionName);
    const label = rawLabel.trim() || sessionName;

    normalized.push({
      sessionName,
      label,
    });
  }

  return normalized;
}

function buildGridTemplate(trackCount: number): string {
  if (trackCount <= 0) return "none";
  if (trackCount === 1) return "minmax(0, 1fr)";
  return `repeat(${trackCount}, minmax(0, 1fr))`;
}

function slugifyPaneId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}
