import { isApplePlatform } from "@/lib/keyboard-shortcuts";
import type { GeneralBoard } from "./general-workspace";
import {
  detachColumn,
  joinColumn,
  MIN_WINDOW_WIDTH,
  reconcileWindowManager,
  revealWindow,
  updateColumn,
  WIDTH_PRESETS,
  type WindowManager,
  windowGeometry,
} from "./window-manager";
import {
  equalizeWorkspaceSplits,
  findWorkspaceWindowInDirection,
  moveWorkspaceWindow,
  resizeWorkspaceSplit,
  type WorkspaceWindowDirection,
} from "./workspace-window-layout";

export interface WindowAction {
  id: string;
  label: string;
  chord?: string;
  repeat?: boolean;
  stripOnly?: boolean;
}
export const WINDOW_ACTIONS: WindowAction[] = [
  ...(["left", "down", "up", "right"] as const).flatMap((d) => [
    { id: `focus-${d}`, label: `Focus window ${d}`, chord: `arrow${d}`, repeat: true },
    { id: `move-${d}`, label: `Move window ${d}`, chord: `shift+arrow${d}`, repeat: true },
  ]),
  { id: "first", label: "Focus first column", chord: "home" },
  { id: "last", label: "Focus last column", chord: "end" },
  {
    id: "move-first",
    label: "Move to first column",
    stripOnly: true,
    chord: "shift+home",
  },
  { id: "move-last", label: "Move to last column", stripOnly: true, chord: "shift+end" },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `window-${i + 1}`,
    label: `Focus window ${i + 1}`,
    chord: `${i + 1}`,
  })),
  { id: "cycle-width", label: "Cycle window width", chord: "r" },
  { id: "maximize", label: "Toggle full width", chord: "f" },
  { id: "center", label: "Center column", chord: "c", stripOnly: true },
  { id: "wider", label: "Increase width", chord: "=", repeat: true },
  { id: "narrower", label: "Decrease width", chord: "-", repeat: true },
  { id: "taller", label: "Increase height", chord: "shift+=", repeat: true },
  { id: "shorter", label: "Decrease height", chord: "shift+-", repeat: true },
  { id: "equalize", label: "Equalize window sizes", chord: "0" },
  { id: "pin-left", label: "Toggle pin left", chord: "p", stripOnly: true },
  { id: "pin-right", label: "Toggle pin right", chord: "shift+p", stripOnly: true },
  { id: "join-left", label: "Stack with left column", chord: "]", stripOnly: true },
  { id: "join-right", label: "Stack with right column", chord: "[", stripOnly: true },
  { id: "detach-right", label: "Detach to right column", chord: "shift+]", stripOnly: true },
  { id: "detach-left", label: "Detach to left column", chord: "shift+[", stripOnly: true },
  { id: "tabs", label: "Toggle stack / tabs", chord: "shift+t", stripOnly: true },
  { id: "float", label: "Toggle floating window", chord: "t" },
  { id: "next-board", label: "Move window to next workspace", chord: "n" },
  { id: "previous-board", label: "Move window to previous workspace", chord: "shift+n" },
  { id: "shortcuts", label: "Toggle layout shortcuts", chord: "q" },
  { id: "grid", label: "Use Grid layout" },
  { id: "strip", label: "Use Strip layout" },
];
function canonical(parts: string[]): string {
  const mods = ["ctrl", "cmd", "alt", "shift"].filter((mod) => parts.includes(mod));
  return [...mods, ...parts.filter((p) => !mods.includes(p))].join("+");
}
function nextPresetWidth(value: number, min: number, max: number): number {
  // Several presets collapse to the same minimum on a phone. Skip those so
  // each tap changes the rendered width, and wrap to the smallest usable size.
  const presets = WIDTH_PRESETS.map((width) => Math.max(min, Math.min(max, width)));
  return presets.find((width) => width > value + 0.01) ?? presets[0];
}
export function windowActionKeys(
  action: WindowAction,
  preset: WindowManager["shortcuts"],
  isApple = isApplePlatform(),
): string[] {
  if (!action.chord || preset === "off") return [];
  const primary = isApple ? "cmd" : "ctrl";
  const parts = [primary, "alt", ...action.chord.split("+")];
  const keys = [
    canonical(action.id.startsWith("focus-") ? parts.filter((p) => p !== "alt") : parts),
  ];
  const d = /arrow(left|down|up|right)$/.exec(action.chord)?.[1];
  if (d)
    keys.push(
      canonical([
        ...parts.slice(0, -1),
        ({ left: "h", down: "j", up: "k", right: "l" } as Record<string, string>)[d],
      ]),
    );
  return keys;
}
export function applyWindowAction(
  board: GeneralBoard,
  action: string,
  width: number,
  height: number,
): GeneralBoard {
  const ids = board.windows.map((w) => w.id),
    active = board.activeWindowId ?? ids[0];
  let manager = reconcileWindowManager(board.manager, ids);
  if (action === "grid" || action === "strip")
    return { ...board, manager: { ...manager, mode: action, maximized: undefined } };
  if (action === "shortcuts")
    return {
      ...board,
      manager: { ...manager, shortcuts: manager.shortcuts === "off" ? "primary+alt" : "off" },
    };
  if (!active) return board;
  const geometry = windowGeometry(
    action.startsWith("focus-") ? { ...manager, maximized: undefined } : manager,
    board.layout,
    ids,
    active,
    width,
    height,
  );
  const column = manager.columns.find((c) => c.windows.includes(active));
  const visibleRects = new Map([...geometry.rects].filter(([id]) => !geometry.hidden.has(id)));
  let target: string | undefined | null;
  if (action.startsWith("window-")) target = ids[Number(action.slice(7)) - 1];
  if (action === "first" || action === "last")
    target =
      manager.columns[action === "first" ? 0 : manager.columns.length - 1]?.windows[0] ?? ids[0];
  if (action.startsWith("focus-")) {
    const direction = action.slice(6) as WorkspaceWindowDirection;
    if (
      manager.mode === "strip" &&
      column?.tabbed &&
      (direction === "up" || direction === "down")
    ) {
      target = column.windows[column.windows.indexOf(active) + (direction === "up" ? -1 : 1)];
    } else target = findWorkspaceWindowInDirection(visibleRects, active, direction);
  }
  if (target)
    return {
      ...board,
      activeWindowId: target,
      manager: revealWindow(
        { ...manager, maximized: manager.maximized ? target : undefined },
        geometry,
        target,
        width,
      ),
    };
  if (action === "center") manager = revealWindow(manager, geometry, active, width, true);
  if (action === "maximize") {
    if (manager.mode === "strip" && column)
      manager = updateColumn(manager, column.id, (c) => ({ ...c, width: c.width === 1 ? 0.5 : 1 }));
    else manager = { ...manager, maximized: manager.maximized === active ? undefined : active };
  }
  const sizing = ["cycle-width", "wider", "narrower", "taller", "shorter", "equalize"].includes(
    action,
  );
  if (action === "equalize" && manager.mode === "grid" && board.layout && !manager.floating[active])
    return { ...board, layout: equalizeWorkspaceSplits(board.layout) };
  if (sizing) {
    const vertical = action === "taller" || action === "shorter";
    const delta = action === "narrower" || action === "shorter" ? -0.05 : 0.05;
    const floating = manager.floating[active];
    if (floating) {
      const axis = vertical ? "height" : "width";
      manager = {
        ...manager,
        floating: {
          ...manager.floating,
          [active]: {
            ...floating,
            [axis]:
              action === "cycle-width"
                ? nextPresetWidth(
                    (geometry.rects.get(active)?.width ?? floating.width * width) / width,
                    Math.min(1, MIN_WINDOW_WIDTH / width),
                    1,
                  )
                : Math.max(0.25, Math.min(1, floating[axis] + delta)),
          },
        },
      };
    } else if (manager.mode === "strip" && column) {
      const divider = geometry.dividers.find(
        (d) => d.target.kind === "column" && d.target.id === column.id,
      );
      manager = updateColumn(manager, column.id, (c) => ({
        ...c,
        width:
          !vertical && action !== "equalize"
            ? action === "cycle-width"
              ? nextPresetWidth(divider?.value ?? c.width, divider?.min ?? 0.25, divider?.max ?? 1)
              : Math.max(0.25, Math.min(1, c.width + delta))
            : c.width,
        weights:
          action === "equalize"
            ? Object.fromEntries(c.windows.map((id) => [id, 1]))
            : vertical
              ? {
                  ...c.weights,
                  [active]: Math.max(0.05, Math.min(100, (c.weights[active] ?? 1) + delta * 10)),
                }
              : c.weights,
      }));
    } else if (board.layout) {
      const divider = [...geometry.dividers].reverse().find((d) => {
        if (d.axis !== (vertical ? "height" : "width")) return false;
        const rect = geometry.rects.get(active)!;
        // Parallel dividers in other rows/columns can share this edge's
        // coordinate. Only resize one whose span overlaps the active pane.
        const overlaps =
          d.axis === "width"
            ? rect.y < d.rect.y + d.rect.height && rect.y + rect.height > d.rect.y
            : rect.x < d.rect.x + d.rect.width && rect.x + rect.width > d.rect.x;
        if (!overlaps) return false;
        return d.axis === "width"
          ? Math.abs(rect.x + rect.width - d.rect.x - 4) < 1 || Math.abs(rect.x - d.rect.x - 4) < 1
          : Math.abs(rect.y + rect.height - d.rect.y - 4) < 1 ||
              Math.abs(rect.y - d.rect.y - 4) < 1;
      });
      if (divider?.target.kind === "grid") {
        const r = geometry.rects.get(active)!;
        const before = vertical ? r.y < divider.rect.y : r.x < divider.rect.x;
        const value = action === "equalize" ? 0.5 : divider.value + delta * (before ? 1 : -1);
        return {
          ...board,
          layout: resizeWorkspaceSplit(
            board.layout,
            divider.target.path,
            Math.max(divider.min, Math.min(divider.max, value)),
          ),
        };
      }
    }
  }
  if (column && action.startsWith("pin-")) {
    const side = action === "pin-left" ? "left" : "right";
    manager = {
      ...manager,
      columns: manager.columns.map((c) => ({
        ...c,
        width:
          c.id === column.id && c.pin !== side ? Math.min(0.3, Math.max(0.25, c.width)) : c.width,
        pin:
          c.id === column.id
            ? c.pin === side
              ? undefined
              : side
            : c.pin === side
              ? undefined
              : c.pin,
      })),
    };
  }
  if (column && action === "tabs")
    manager = updateColumn(manager, column.id, (c) => ({
      ...c,
      tabbed: !c.tabbed,
      selected: active,
    }));
  if (action.startsWith("join-"))
    manager = joinColumn(manager, active, action === "join-left" ? -1 : 1);
  if (action.startsWith("detach-"))
    manager = detachColumn(manager, active, action === "detach-left" ? -1 : 1);
  if (action === "float") {
    const floating = { ...manager.floating };
    if (floating[active]) delete floating[active];
    else floating[active] = { x: 0.15, y: 0.1, width: 0.6, height: 0.7 };
    manager = reconcileWindowManager({ ...manager, floating }, ids);
  }
  if (action.startsWith("move-")) {
    if (manager.floating[active]) {
      const r = manager.floating[active],
        d = action.slice(5);
      manager = {
        ...manager,
        floating: {
          ...manager.floating,
          [active]: {
            ...r,
            x: Math.max(
              0,
              Math.min(1 - r.width, r.x + (d === "left" ? -0.05 : d === "right" ? 0.05 : 0)),
            ),
            y: Math.max(
              0,
              Math.min(1 - r.height, r.y + (d === "up" ? -0.05 : d === "down" ? 0.05 : 0)),
            ),
          },
        },
      };
    } else if (manager.mode === "strip" && column) {
      const columns = [...manager.columns],
        from = columns.indexOf(column),
        direction = action.slice(5);
      if (direction === "up" || direction === "down") {
        const windows = [...column.windows],
          a = windows.indexOf(active),
          b = a + (direction === "up" ? -1 : 1);
        if (windows[b]) {
          [windows[a], windows[b]] = [windows[b], windows[a]];
          manager = updateColumn(manager, column.id, (c) => ({ ...c, windows }));
        }
      } else {
        const to =
          direction === "first"
            ? 0
            : direction === "last"
              ? columns.length - 1
              : from + (direction === "left" ? -1 : 1);
        if (to >= 0 && to < columns.length) {
          columns.splice(from, 1);
          columns.splice(to, 0, column);
          manager = { ...manager, columns };
        }
      }
    } else if (board.layout && !["move-first", "move-last"].includes(action)) {
      const direction = action.slice(5) as WorkspaceWindowDirection;
      const other = findWorkspaceWindowInDirection(visibleRects, active, direction);
      if (other)
        return {
          ...board,
          layout: moveWorkspaceWindow(
            board.layout,
            active,
            other,
            direction === "up" ? "top" : direction === "down" ? "bottom" : direction,
          ),
        };
    }
  }
  return {
    ...board,
    manager: revealWindow(
      manager,
      windowGeometry(manager, board.layout, ids, active, width, height),
      active,
      width,
    ),
  };
}
