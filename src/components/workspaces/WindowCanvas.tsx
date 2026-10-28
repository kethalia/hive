"use client";
import {
  DndContext,
  type DragEndEvent,
  type DraggableSyntheticListeners,
  type DragMoveEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { ShortcutTooltip } from "@/components/ui/shortcut-tooltip";
import { useWindowSwipe } from "@/hooks/useWindowSwipe";
import type { GeneralBoard, GeneralWindow } from "@/lib/workspaces/general-workspace";
import {
  type LayoutDivider,
  reconcileWindowManager,
  updateColumn,
  type WindowGeometry,
  windowGeometry,
} from "@/lib/workspaces/window-manager";
import {
  moveWorkspaceWindow,
  resizeWorkspaceSplit,
  workspaceWindowDropPosition,
  workspaceWindowIds,
} from "@/lib/workspaces/workspace-window-layout";
import { WindowResizeHandle } from "./WindowResizeHandle";
import { WorkspaceWindow, WorkspaceWindowDropPlaceholder } from "./WorkspaceWindow";

interface Props {
  boards: GeneralBoard[];
  activeBoardKey: string;
  width: number;
  height: number;
  mobile: boolean;
  onBoardChange: (key: string, change: (board: GeneralBoard) => GeneralBoard) => void;
  onActivate: (key: string, id: string) => void;
  renderPane: (
    board: GeneralBoard,
    pane: GeneralWindow,
    visible: boolean,
    rect: string,
    listeners?: DraggableSyntheticListeners,
  ) => ReactNode;
}
function styleRect(rect: { x: number; y: number; width: number; height: number }): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}
export function WindowCanvas({
  boards,
  activeBoardKey,
  width,
  height,
  mobile,
  onBoardChange,
  onActivate,
  renderPane,
}: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [resizing, setResizing] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [preview, setPreview] = useState<GeneralBoard | null>(null);
  const origin = useRef<GeneralBoard | null>(null);
  const activeBoard = boards.find((b) => b.key === activeBoardKey)!;
  const scroller = useRef<HTMLDivElement>(null);
  const canvasHeight = Math.max(1, height);
  const geometry = (b: GeneralBoard): WindowGeometry =>
    windowGeometry(
      reconcileWindowManager(
        b.manager,
        b.windows.map((w) => w.id),
      ),
      b.layout,
      b.windows.map((w) => w.id),
      b.activeWindowId,
      width,
      canvasHeight,
      { showColumnTabs: !mobile },
    );
  const activeGeometry = geometry(preview ?? activeBoard);
  const manager = reconcileWindowManager(
    activeBoard.manager,
    activeBoard.windows.map((w) => w.id),
  );
  const resizeDividers = activeGeometry.dividers.filter(
    (divider) => !(mobile && manager.mode === "strip" && divider.axis === "width"),
  );
  useWindowSwipe(scroller, mobile, (direction) => {
    const tiled =
      manager.mode === "strip"
        ? [
            ...manager.columns.filter((column) => column.pin === "left"),
            ...manager.columns.filter((column) => !column.pin),
            ...manager.columns.filter((column) => column.pin === "right"),
          ].flatMap((column) => column.windows)
        : activeBoard.layout
          ? workspaceWindowIds(activeBoard.layout)
          : [];
    const ids = activeBoard.windows.map((window) => window.id);
    const order = [...new Set([...tiled, ...ids])].filter((id) => ids.includes(id));
    const index = order.indexOf(activeBoard.activeWindowId ?? order[0]);
    const next = order[index + (direction === "left" ? 1 : -1)];
    if (next) onActivate(activeBoardKey, next);
  });
  const wheelState = useRef({
    mobile,
    manager,
    activeBoardKey,
    activeGeometry,
    width,
    onBoardChange,
  });
  wheelState.current = { mobile, manager, activeBoardKey, activeGeometry, width, onBoardChange };
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (event: WheelEvent) => {
      const state = wheelState.current;
      if (state.mobile || state.manager.mode !== "strip" || event.ctrlKey || event.metaKey) return;
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!horizontal || !delta || !state.activeGeometry.maxScroll) return;
      // Capture before xterm consumes wheel events. A non-passive listener also
      // prevents browser back/forward gestures and duplicate native scrolling.
      event.preventDefault();
      event.stopPropagation();
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.width : 1);
      state.onBoardChange(state.activeBoardKey, (board) => {
        const current = reconcileWindowManager(
          board.manager,
          board.windows.map((w) => w.id),
        );
        return {
          ...board,
          manager: {
            ...current,
            scroll: Math.max(
              0,
              Math.min(
                state.activeGeometry.maxScroll,
                Math.min(current.scroll, state.activeGeometry.maxScroll) + pixels,
              ),
            ),
          },
        };
      });
      setScrolling(true);
      clearTimeout(settle);
      settle = setTimeout(() => setScrolling(false), 150);
    };
    element.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel, { capture: true });
      clearTimeout(settle);
    };
  }, []);
  const {
    x,
    y,
    width: focusedWidth,
    height: focusedHeight,
  } = activeGeometry.rects.get(activeBoard.activeWindowId ?? "") ?? {};
  useEffect(() => {
    const element = scroller.current;
    if (
      !element ||
      manager.mode !== "grid" ||
      dragId ||
      resizing ||
      x === undefined ||
      focusedWidth === undefined
    )
      return;
    if (x < element.scrollLeft) element.scrollLeft = x;
    else if (x + focusedWidth > element.scrollLeft + element.clientWidth)
      element.scrollLeft = x + focusedWidth - element.clientWidth;
  }, [manager.mode, dragId, resizing, x, focusedWidth]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing focus must reveal the pane even when its vertical geometry matches the previous pane.
  useEffect(() => {
    const element = scroller.current;
    if (!element || dragId || resizing || y === undefined || focusedHeight === undefined) return;
    const visibleHeight = Math.min(height, element.clientHeight);
    if (visibleHeight <= 0) return;
    // Strip owns horizontal movement in its manager, but tall stacks still use
    // native vertical scrolling. Keep this independent of horizontal pan updates.
    if (y < element.scrollTop) element.scrollTop = y;
    else if (y + focusedHeight > element.scrollTop + visibleHeight)
      element.scrollTop = y + Math.min(0, focusedHeight - visibleHeight);
  }, [activeBoardKey, activeBoard.activeWindowId, dragId, resizing, y, focusedHeight, height]);
  function clear() {
    origin.current = null;
    setPreview(null);
    setDragId(null);
  }
  function proposed(event: DragMoveEvent | DragEndEvent): GeneralBoard | null {
    const original = origin.current;
    if (!original) return null;
    const id = String(event.active.id),
      m = reconcileWindowManager(
        original.manager,
        original.windows.map((w) => w.id),
      );
    if (m.floating[id]) {
      const r = m.floating[id];
      return {
        ...original,
        manager: {
          ...m,
          floating: {
            ...m.floating,
            [id]: {
              ...r,
              x: Math.max(0, Math.min(1 - r.width, r.x + event.delta.x / width)),
              y: Math.max(0, Math.min(1 - r.height, r.y + event.delta.y / canvasHeight)),
            },
          },
        },
      };
    }
    const target = event.over;
    if (!target || id === target.id) return null;
    const other = String(target.id);
    if (m.mode === "strip") {
      const from = m.columns.findIndex((c) => c.windows.includes(id)),
        to = m.columns.findIndex((c) => c.windows.includes(other));
      if (from < 0 || to < 0) return null;
      const columns = m.columns.map((c) => ({ ...c, windows: [...c.windows] }));
      if (from === to) {
        const a = columns[from].windows.indexOf(id),
          b = columns[from].windows.indexOf(other);
        [columns[from].windows[a], columns[from].windows[b]] = [
          columns[from].windows[b],
          columns[from].windows[a],
        ];
      } else {
        const [column] = columns.splice(from, 1);
        columns.splice(to, 0, column);
      }
      return { ...original, manager: { ...m, columns } };
    }
    if (!original.layout) return null;
    const rect = target.rect,
      moved = event.active.rect.current.translated;
    const position = workspaceWindowDropPosition(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      {
        x: moved ? moved.left + moved.width / 2 : rect.left,
        y: moved ? moved.top + moved.height / 2 : rect.top,
      },
    );
    return { ...original, layout: moveWorkspaceWindow(original.layout, id, other, position) };
  }
  function resize(divider: LayoutDivider, value: number) {
    onBoardChange(activeBoardKey, (board) => {
      const m = reconcileWindowManager(
          board.manager,
          board.windows.map((w) => w.id),
        ),
        target = divider.target;
      if (target.kind === "grid")
        return {
          ...board,
          layout: board.layout
            ? resizeWorkspaceSplit(board.layout, target.path, value)
            : board.layout,
        };
      const resized = {
        ...board,
        manager: updateColumn(m, target.id, (c) => {
          if (target.kind === "column") return { ...c, width: value };
          const total = (c.weights[target.before] ?? 1) + (c.weights[target.after] ?? 1);
          const before = Math.max(0.05, Math.min(total - 0.05, total * value));
          return {
            ...c,
            weights: { ...c.weights, [target.before]: before, [target.after]: total - before },
          };
        }),
      };
      if (
        target.kind === "column" &&
        divider.edge === "start" &&
        !m.columns.find((c) => c.id === target.id)?.pin
      ) {
        // Growing the last column from its left edge keeps its right edge in view.
        const before = geometry(board);
        const after = geometry(resized);
        resized.manager.scroll = Math.max(
          0,
          Math.min(
            after.maxScroll,
            Math.min(m.scroll, before.maxScroll) +
              (value - divider.value) * Math.abs(divider.extent),
          ),
        );
      }
      return resized;
    });
  }
  return (
    <div
      className="absolute inset-0 isolate flex min-h-0 flex-col"
      style={{ pointerEvents: activeBoard.windows.length ? undefined : "none" }}
      data-window-layout={manager.mode}
    >
      <div
        ref={scroller}
        className={`relative min-h-0 flex-1 overflow-auto ${manager.mode === "strip" ? "overflow-x-hidden overscroll-x-none" : ""} ${dragId || resizing ? "[&_iframe]:pointer-events-none" : ""}`}
        data-mobile-scroll-allow="true"
      >
        <div
          className="relative"
          style={{
            width: activeGeometry.width,
            height: activeGeometry.height,
            overflow: manager.mode === "strip" ? "hidden" : undefined,
          }}
        >
          <DndContext
            sensors={sensors}
            onDragStart={(e) => {
              origin.current = activeBoard;
              setDragId(String(e.active.id));
            }}
            onDragMove={(e) => {
              const next = proposed(e);
              setPreview(next);
            }}
            onDragCancel={clear}
            onDragEnd={(e) => {
              const next = proposed(e);
              if (next)
                onBoardChange(next.key, () => ({ ...next, activeWindowId: String(e.active.id) }));
              clear();
            }}
          >
            {boards.flatMap((b) => {
              const original = geometry(b),
                g = preview?.key === b.key ? geometry(preview) : original;
              const m = reconcileWindowManager(
                b.manager,
                b.windows.map((w) => w.id),
              );
              const floatingResizeAxes =
                mobile && m.mode === "strip"
                  ? (["height"] as const)
                  : (["width", "height"] as const);
              return b.windows.map((pane) => {
                const focused = pane.id === (b.activeWindowId ?? b.windows[0]?.id);
                const visible = b.key === activeBoardKey && !g.hidden.has(pane.id);
                const rect = g.rects.get(pane.id) ?? { x: 0, y: 0, width, height };
                const baseRect = original.rects.get(pane.id) ?? rect;
                const pinned = m.columns.some((c) => c.pin && c.windows.includes(pane.id));
                const zIndex = m.floating[pane.id] ? (focused ? 45 : 44) : pinned ? 10 : 1;
                return (
                  <WorkspaceWindow
                    key={pane.id}
                    id={pane.id}
                    style={{
                      ...styleRect(baseRect),
                      display: visible ? "block" : "none",
                      zIndex,
                      ...(resizing || scrolling ? { transition: "none" } : {}),
                    }}
                    previewStyle={
                      preview?.key === b.key
                        ? { ...styleRect(rect), display: visible ? "block" : "none", zIndex }
                        : undefined
                    }
                  >
                    {({ dragHandleListeners }) => (
                      <>
                        {renderPane(b, pane, visible, JSON.stringify(rect), dragHandleListeners)}
                        {visible && !dragId && !m.maximized && m.floating[pane.id]
                          ? floatingResizeAxes.map((axis) => (
                              <WindowResizeHandle
                                key={axis}
                                touchOptimized={mobile}
                                label={`Resize floating ${axis}`}
                                axis={axis}
                                value={rect[axis] / (axis === "width" ? width : canvasHeight)}
                                min={
                                  axis === "width"
                                    ? Math.min(1, 280 / width)
                                    : Math.min(1, 160 / canvasHeight)
                                }
                                max={
                                  1 - (axis === "width" ? rect.x / width : rect.y / canvasHeight)
                                }
                                extent={axis === "width" ? width : canvasHeight}
                                style={
                                  mobile
                                    ? {
                                        left:
                                          axis === "width"
                                            ? rect.width - 44
                                            : (rect.width - 44) / 2,
                                        top:
                                          axis === "height"
                                            ? rect.height - 44
                                            : (rect.height - 44) / 2,
                                        width: 44,
                                        height: 44,
                                      }
                                    : axis === "width"
                                      ? {
                                          left: rect.width - 6,
                                          top: 35,
                                          width: 6,
                                          height: rect.height - 35,
                                        }
                                      : {
                                          left: 0,
                                          top: rect.height - 6,
                                          width: rect.width,
                                          height: 6,
                                        }
                                }
                                onInteraction={(active) => {
                                  setResizing(active);
                                  if (active) onActivate(b.key, pane.id);
                                }}
                                onChange={(value) =>
                                  onBoardChange(b.key, (board) => ({
                                    ...board,
                                    activeWindowId: pane.id,
                                    manager: {
                                      ...m,
                                      floating: {
                                        ...m.floating,
                                        [pane.id]: {
                                          ...m.floating[pane.id],
                                          x: rect.x / width,
                                          y: rect.y / canvasHeight,
                                          [axis]: value,
                                        },
                                      },
                                    },
                                  }))
                                }
                              />
                            ))
                          : null}
                      </>
                    )}
                  </WorkspaceWindow>
                );
              });
            })}
            {preview && dragId && activeGeometry.rects.has(dragId) ? (
              <WorkspaceWindowDropPlaceholder
                kind="destination"
                style={styleRect(activeGeometry.rects.get(dragId)!)}
              />
            ) : null}
          </DndContext>
          {!dragId
            ? resizeDividers.map((d) => (
                <WindowResizeHandle
                  key={d.id}
                  touchOptimized={mobile}
                  label={`Resize ${d.axis}`}
                  axis={d.axis}
                  value={d.value}
                  min={d.min}
                  max={d.max}
                  extent={d.extent}
                  style={styleRect(
                    mobile
                      ? {
                          x:
                            d.edge === "start"
                              ? d.rect.x
                              : d.edge === "end"
                                ? d.rect.x + d.rect.width - 44
                                : d.rect.x + d.rect.width / 2 - 22,
                          y: d.rect.y + d.rect.height / 2 - 22,
                          width: 44,
                          height: 44,
                        }
                      : d.rect,
                  )}
                  onChange={(value) => resize(d, value)}
                  onInteraction={setResizing}
                />
              ))
            : null}
          {!mobile
            ? activeGeometry.tabs.map(({ column, rect }) => (
                <div
                  key={column.id}
                  role="tablist"
                  aria-label="Column windows"
                  className="absolute z-20 flex overflow-x-auto border bg-background"
                  style={styleRect(rect)}
                >
                  {column.windows.map((id, index) => (
                    <ShortcutTooltip
                      key={id}
                      label={`Focus ${activeBoard.windows.find((w) => w.id === id)?.label}`}
                      trigger={
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={column.selected === id}
                          tabIndex={column.selected === id ? 0 : -1}
                          onKeyDown={(event) => {
                            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
                              return;
                            event.preventDefault();
                            const next =
                              event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? column.windows.length - 1
                                  : (index +
                                      (event.key === "ArrowLeft" ? -1 : 1) +
                                      column.windows.length) %
                                    column.windows.length;
                            const tabs =
                              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                                '[role="tab"]',
                              );
                            onActivate(activeBoardKey, column.windows[next]);
                            tabs?.[next]?.focus();
                          }}
                          className="min-w-0 shrink-0 px-3 text-xs hover:bg-accent aria-selected:bg-accent"
                          onClick={() => onActivate(activeBoardKey, id)}
                        >
                          {activeBoard.windows.find((w) => w.id === id)?.label}
                        </button>
                      }
                    />
                  ))}
                </div>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
