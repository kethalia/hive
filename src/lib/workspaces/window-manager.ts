import { z } from "zod";
import {
  reconcileWorkspaceWindowLayout,
  splitRatio,
  type WorkspaceWindowLayoutNode,
  type WorkspaceWindowRect,
} from "./workspace-window-layout";

export const MIN_WINDOW_WIDTH = 280;
export const MIN_WINDOW_HEIGHT = 160;
export const WIDTH_PRESETS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1];
const fraction = z.number().finite().min(0.05).max(1);
const columnSchema = z.object({
  id: z.string().max(220),
  windows: z.array(z.string().max(200)).max(32),
  width: fraction,
  weights: z.record(z.number().finite().min(0.05).max(100)),
  tabbed: z.boolean(),
  selected: z.string().optional(),
  pin: z.enum(["left", "right"]).optional(),
});
export const windowManagerSchema = z.object({
  mode: z.enum(["grid", "strip"]),
  columns: z.array(columnSchema).max(32),
  floating: z.record(
    z.object({
      x: z.number().finite().min(0).max(1),
      y: z.number().finite().min(0).max(1),
      width: fraction,
      height: fraction,
    }),
  ),
  maximized: z.string().optional(),
  scroll: z.number().finite().min(0).max(100000).default(0),
  shortcuts: z.enum(["ctrl+alt", "ctrl+cmd", "off"]).default("ctrl+alt"),
});
export type WindowManager = z.infer<typeof windowManagerSchema>;
export type WindowColumn = WindowManager["columns"][number];
export function newWindowManager(mode: WindowManager["mode"] = "strip"): WindowManager {
  return { mode, columns: [], floating: {}, scroll: 0, shortcuts: "ctrl+alt" };
}
export function reconcileWindowManager(
  value: WindowManager | undefined,
  ids: string[],
  anchor?: string,
): WindowManager {
  const manager = value ?? newWindowManager("grid");
  const allowed = new Set(ids),
    seen = new Set<string>();
  const floating = Object.fromEntries(
    Object.entries(manager.floating).filter(([id]) => allowed.has(id)),
  );
  const pins = new Set<string>();
  const columnIds = new Set<string>();
  const columns = manager.columns.flatMap((c) => {
    const windows = c.windows.filter((id) => {
      if (!allowed.has(id) || seen.has(id) || floating[id]) return false;
      seen.add(id);
      return true;
    });
    if (!windows.length) return [];
    const pin = c.pin && !pins.has(c.pin) ? c.pin : undefined;
    if (pin) pins.add(pin);
    let columnId = c.id;
    let suffix = 1;
    while (columnIds.has(columnId)) columnId = `${c.id}-${suffix++}`;
    columnIds.add(columnId);
    return [
      {
        ...c,
        id: columnId,
        windows,
        pin,
        selected: windows.includes(c.selected ?? "") ? c.selected : windows[0],
        weights: Object.fromEntries(windows.map((id) => [id, c.weights[id] ?? 1])),
      },
    ];
  });
  for (const id of ids) {
    if (seen.has(id) || floating[id]) continue;
    const at = columns.findIndex((c) => c.windows.includes(anchor ?? ""));
    columns.splice(at < 0 ? columns.length : at + 1, 0, {
      id: uniqueColumnId(columns, id),
      windows: [id],
      width: 0.5,
      weights: { [id]: 1 },
      tabbed: false,
      selected: id,
      pin: undefined,
    });
    anchor = id;
  }
  return {
    ...manager,
    columns,
    floating,
    maximized: allowed.has(manager.maximized ?? "") ? manager.maximized : undefined,
  };
}
export interface LayoutDivider {
  id: string;
  axis: "width" | "height";
  rect: WorkspaceWindowRect;
  value: number;
  min: number;
  max: number;
  extent: number;
  target:
    | { kind: "grid"; path: string }
    | { kind: "column"; id: string }
    | { kind: "stack"; id: string; before: string; after: string };
}
export interface WindowGeometry {
  rects: Map<string, WorkspaceWindowRect>;
  hidden: Set<string>;
  dividers: LayoutDivider[];
  tabs: { column: WindowColumn; rect: WorkspaceWindowRect }[];
  width: number;
  height: number;
  left: number;
  right: number;
  maxScroll: number;
}
export function minimumGridSize(root: WorkspaceWindowLayoutNode): {
  width: number;
  height: number;
} {
  if (root.type === "leaf") return { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT };
  const a = minimumGridSize(root.first),
    b = minimumGridSize(root.second);
  return root.axis === "y"
    ? { width: a.width + b.width, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height };
}
export function windowGeometry(
  manager: WindowManager,
  root: WorkspaceWindowLayoutNode | undefined,
  ids: string[],
  active: string | undefined,
  width: number,
  height: number,
): WindowGeometry {
  const result: WindowGeometry = {
    rects: new Map(),
    hidden: new Set(),
    dividers: [],
    tabs: [],
    width,
    height,
    left: 0,
    right: 0,
    maxScroll: 0,
  };
  const tiled = ids.filter((id) => !manager.floating[id]);
  if (manager.mode === "grid") {
    const grid = reconcileWorkspaceWindowLayout(root, tiled, {
      viewportWidth: width,
      viewportHeight: height,
    });
    if (grid) {
      const minimum = minimumGridSize(grid);
      result.width = Math.max(width, minimum.width);
      result.height = Math.max(height, minimum.height);
      const visit = (node: WorkspaceWindowLayoutNode, rect: WorkspaceWindowRect, path: string) => {
        if (node.type === "leaf") {
          result.rects.set(node.id, rect);
          return;
        }
        const axis = node.axis === "y" ? "width" : "height",
          position = axis === "width" ? "x" : "y";
        const min = minimumGridSize(node.first)[axis] / rect[axis],
          max = 1 - minimumGridSize(node.second)[axis] / rect[axis];
        const ratio = Math.max(min, Math.min(max, splitRatio(node)));
        const size = rect[axis] * ratio;
        visit(node.first, { ...rect, [axis]: size }, `${path}0`);
        visit(
          node.second,
          { ...rect, [position]: rect[position] + size, [axis]: rect[axis] - size },
          `${path}1`,
        );
        result.dividers.push({
          id: `grid-${path}`,
          axis,
          rect: { ...rect, [position]: rect[position] + size - 4, [axis]: 8 },
          value: ratio,
          min,
          max,
          extent: rect[axis],
          target: { kind: "grid", path },
        });
      };
      visit(grid, { x: 0, y: 0, width: result.width, height: result.height }, "");
    }
  } else {
    const pinned = manager.columns.filter((c) => c.pin);
    for (const c of pinned) result[c.pin!] = Math.min(width * 0.3, Math.max(180, c.width * width));
    const available = Math.max(200, width - result.left - result.right);
    let cursor = result.left;
    const place = (c: WindowColumn, x: number, w: number) => {
      const h = Math.max(
        height,
        c.tabbed ? MIN_WINDOW_HEIGHT : c.windows.length * MIN_WINDOW_HEIGHT,
      );
      result.height = Math.max(result.height, h);
      const selected = c.windows.includes(active ?? "") ? active : (c.selected ?? c.windows[0]);
      let y = c.tabbed ? 32 : 0;
      const extra = h - c.windows.length * MIN_WINDOW_HEIGHT;
      const total = c.windows.reduce((sum, id) => sum + (c.weights[id] ?? 1), 0);
      if (c.tabbed)
        result.tabs.push({ column: { ...c, selected }, rect: { x, y: 0, width: w, height: 32 } });
      c.windows.forEach((id, index) => {
        const paneHeight = c.tabbed
          ? h - 32
          : MIN_WINDOW_HEIGHT + (extra * (c.weights[id] ?? 1)) / total;
        result.rects.set(id, { x, y, width: w, height: paneHeight });
        if (c.tabbed && id !== selected) result.hidden.add(id);
        if (!c.tabbed) {
          y += paneHeight;
          const after = c.windows[index + 1];
          if (after)
            result.dividers.push({
              id: `stack-${id}`,
              axis: "height",
              rect: { x, y: y - 4, width: w, height: 8 },
              value: (c.weights[id] ?? 1) / ((c.weights[id] ?? 1) + (c.weights[after] ?? 1)),
              min: 0.05 / ((c.weights[id] ?? 1) + (c.weights[after] ?? 1)),
              max: 1 - 0.05 / ((c.weights[id] ?? 1) + (c.weights[after] ?? 1)),
              extent: Math.max(
                1,
                (extra * ((c.weights[id] ?? 1) + (c.weights[after] ?? 1))) / total,
              ),
              target: { kind: "stack", id: c.id, before: id, after },
            });
        }
      });
      result.dividers.push({
        id: c.id,
        axis: "width",
        rect: { x: c.pin === "right" ? x : x + w - 4, y: 0, width: 8, height: h },
        value: w / (c.pin ? width : available),
        min: c.pin
          ? Math.max(0.05, Math.min(0.25, 180 / width))
          : Math.min(MIN_WINDOW_WIDTH, available) / available,
        max: c.pin ? 0.3 : 1,
        extent: (c.pin === "right" ? -1 : 1) * (c.pin ? width : available),
        target: { kind: "column", id: c.id },
      });
    };
    for (const c of manager.columns.filter((c) => !c.pin)) {
      const w = Math.max(Math.min(MIN_WINDOW_WIDTH, available), c.width * available);
      place(c, cursor, w);
      cursor += w;
    }
    result.maxScroll = Math.max(0, cursor + result.right - width);
    const scroll = Math.min(manager.scroll, result.maxScroll);
    for (const [id, rect] of result.rects) result.rects.set(id, { ...rect, x: rect.x - scroll });
    for (const divider of result.dividers) divider.rect.x -= scroll;
    for (const tab of result.tabs) tab.rect.x -= scroll;
    for (const c of pinned) place(c, c.pin === "left" ? 0 : width - result.right, result[c.pin!]);
  }
  for (const [id, r] of Object.entries(manager.floating)) {
    const w = Math.min(width, Math.max(MIN_WINDOW_WIDTH, r.width * width));
    const h = Math.min(height, Math.max(MIN_WINDOW_HEIGHT, r.height * height));
    result.rects.set(id, {
      x: Math.min(r.x * width, width - w),
      y: Math.min(r.y * height, height - h),
      width: w,
      height: h,
    });
  }
  if (manager.maximized) {
    for (const id of ids) if (id !== manager.maximized) result.hidden.add(id);
    result.rects.set(manager.maximized, { x: 0, y: 0, width, height });
    result.dividers = [];
    result.tabs = [];
  }
  return result;
}

export function updateColumn(
  manager: WindowManager,
  id: string,
  change: (c: WindowColumn) => WindowColumn,
): WindowManager {
  return { ...manager, columns: manager.columns.map((c) => (c.id === id ? change(c) : c)) };
}
export function joinColumn(manager: WindowManager, id: string, direction: -1 | 1): WindowManager {
  const index = manager.columns.findIndex((c) => c.windows.includes(id));
  const target = manager.columns[index + direction];
  if (index < 0 || !target) return manager;
  return {
    ...manager,
    columns: manager.columns
      .map((c) =>
        c.id === target.id
          ? { ...c, windows: [...c.windows, id], selected: id, weights: { ...c.weights, [id]: 1 } }
          : { ...c, windows: c.windows.filter((w) => w !== id) },
      )
      .filter((c) => c.windows.length),
  };
}
function uniqueColumnId(columns: WindowColumn[], windowId: string): string {
  const base = `column-${windowId}`;
  let id = base,
    suffix = 1;
  while (columns.some((c) => c.id === id)) id = `${base}-${suffix++}`;
  return id;
}
export function detachColumn(manager: WindowManager, id: string, direction: -1 | 1): WindowManager {
  const index = manager.columns.findIndex((c) => c.windows.includes(id));
  const c = manager.columns[index];
  if (!c || c.windows.length < 2) return manager;
  const columns = manager.columns.map((c) => ({
    ...c,
    windows: c.windows.filter((w) => w !== id),
  }));
  columns.splice(index + (direction === 1 ? 1 : 0), 0, {
    id: uniqueColumnId(columns, id),
    windows: [id],
    width: c.width,
    weights: { [id]: 1 },
    tabbed: false,
  });
  return { ...manager, columns };
}

export function revealWindow(
  manager: WindowManager,
  geometry: WindowGeometry,
  id: string,
  width: number,
  center = false,
): WindowManager {
  if (manager.maximized && manager.maximized !== id && geometry.rects.has(id))
    manager = { ...manager, maximized: id };
  // Keep the last viewed tab visible after focus moves to another column. This
  // also applies to pinned columns, which never need horizontal scrolling.
  const column = manager.columns.find((c) => c.windows.includes(id));
  if (column && column.selected !== id)
    manager = updateColumn(manager, column.id, (c) => ({ ...c, selected: id }));
  if (
    manager.mode !== "strip" ||
    manager.floating[id] ||
    manager.columns.some((c) => c.pin && c.windows.includes(id))
  )
    return manager;
  const rect = geometry.rects.get(id);
  if (!rect) return manager;
  const left = geometry.left,
    right = width - geometry.right;
  const delta = center
    ? rect.x + rect.width / 2 - (left + right) / 2
    : rect.x < left
      ? rect.x - left
      : rect.x + rect.width > right
        ? rect.x + rect.width - right
        : 0;
  const scroll = Math.min(manager.scroll, geometry.maxScroll);
  return { ...manager, scroll: Math.max(0, Math.min(geometry.maxScroll, scroll + delta)) };
}
