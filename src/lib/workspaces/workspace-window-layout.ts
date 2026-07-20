export const WORKSPACE_WINDOW_LAYOUT_VERSION = 1;

export type WorkspaceWindowSplitAxis = "x" | "y";
export type WorkspaceWindowDirection = "left" | "right" | "up" | "down";
export type WorkspaceWindowDropPosition = "top" | "bottom" | "left" | "right";

export interface WorkspaceWindowLeaf {
  type: "leaf";
  id: string;
}

export interface WorkspaceWindowSplit {
  type: "split";
  axis: WorkspaceWindowSplitAxis;
  first: WorkspaceWindowLayoutNode;
  second: WorkspaceWindowLayoutNode;
}

export type WorkspaceWindowLayoutNode = WorkspaceWindowLeaf | WorkspaceWindowSplit;

export interface WorkspaceWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceWindowBoardLayout {
  boardKey: string;
  root: WorkspaceWindowLayoutNode;
}

export interface WorkspaceWindowLayoutState {
  version: typeof WORKSPACE_WINDOW_LAYOUT_VERSION;
  boards: WorkspaceWindowBoardLayout[];
}

interface ReconcileWorkspaceWindowLayoutOptions {
  focusedWindowId?: string | null;
  viewportWidth: number;
  viewportHeight: number;
}

const ROOT_RECT: WorkspaceWindowRect = { x: 0, y: 0, width: 1, height: 1 };
const MAX_LAYOUT_DEPTH = 100;

export function emptyWorkspaceWindowLayoutState(): WorkspaceWindowLayoutState {
  return { version: WORKSPACE_WINDOW_LAYOUT_VERSION, boards: [] };
}

export function workspaceWindowLayoutStorageKey(
  workspaceId: string,
  source: "workspace" | "unified",
): string {
  return `workspace-window-layout:${source === "unified" ? "git" : "workspace"}:${workspaceId}`;
}

export function parseWorkspaceWindowLayoutState(
  persistedJson?: string | null,
): WorkspaceWindowLayoutState {
  const parsed = parsePersistedLayoutJson(persistedJson);

  if (
    !isRecord(parsed) ||
    parsed.version !== WORKSPACE_WINDOW_LAYOUT_VERSION ||
    !Array.isArray(parsed.boards)
  ) {
    return emptyWorkspaceWindowLayoutState();
  }

  return {
    version: WORKSPACE_WINDOW_LAYOUT_VERSION,
    boards: parseWorkspaceWindowBoards(parsed.boards),
  };
}

function parsePersistedLayoutJson(persistedJson?: string | null): unknown {
  if (typeof persistedJson !== "string" || persistedJson.trim().length === 0) return null;
  try {
    return JSON.parse(persistedJson);
  } catch {
    return null;
  }
}

function parseWorkspaceWindowBoards(values: unknown[]): WorkspaceWindowBoardLayout[] {
  const boardKeys = new Set<string>();
  const boards: WorkspaceWindowBoardLayout[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const boardKey = normalizeId(value.boardKey);
    if (!boardKey || boardKeys.has(boardKey)) continue;
    const root = parseLayoutNode(value.root, new Set<string>(), 0);
    if (!root) continue;
    boardKeys.add(boardKey);
    boards.push({ boardKey, root });
  }
  return boards;
}

export function serializeWorkspaceWindowLayoutState(state: WorkspaceWindowLayoutState): string {
  return JSON.stringify({
    version: WORKSPACE_WINDOW_LAYOUT_VERSION,
    boards: state.boards,
  } satisfies WorkspaceWindowLayoutState);
}

export function reconcileWorkspaceWindowLayout(
  root: WorkspaceWindowLayoutNode | null | undefined,
  windowIds: readonly string[],
  options: ReconcileWorkspaceWindowLayoutOptions,
): WorkspaceWindowLayoutNode | null {
  const normalizedWindowIds = uniqueWindowIds(windowIds);
  if (normalizedWindowIds.length === 0) return null;

  const allowedWindowIds = new Set(normalizedWindowIds);
  const nextRoot = root
    ? pruneWorkspaceWindowLayout(root, allowedWindowIds, new Set<string>())
    : null;
  const initialRoot = nextRoot ?? { type: "leaf", id: normalizedWindowIds[0] };

  return appendMissingWorkspaceWindows(initialRoot, normalizedWindowIds, options);
}

function appendMissingWorkspaceWindows(
  initialRoot: WorkspaceWindowLayoutNode,
  windowIds: readonly string[],
  options: ReconcileWorkspaceWindowLayoutOptions,
): WorkspaceWindowLayoutNode {
  let nextRoot = initialRoot;
  const placedWindowIds = new Set(workspaceWindowIds(initialRoot));
  let focusedWindowId = preferredPlacedWindowId(
    options.focusedWindowId,
    placedWindowIds,
    initialRoot,
  );

  for (const windowId of windowIds) {
    if (placedWindowIds.has(windowId)) continue;
    const targetWindowId = preferredPlacedWindowId(focusedWindowId, placedWindowIds, nextRoot);
    const targetRect = computeWorkspaceWindowRects(nextRoot).get(targetWindowId) ?? ROOT_RECT;
    nextRoot = splitWorkspaceWindow(
      nextRoot,
      targetWindowId,
      windowId,
      chooseWorkspaceWindowSplitAxis(targetRect, options),
    );
    placedWindowIds.add(windowId);
    focusedWindowId = windowId;
  }

  return nextRoot;
}

function preferredPlacedWindowId(
  preferredWindowId: string | null | undefined,
  placedWindowIds: ReadonlySet<string>,
  root: WorkspaceWindowLayoutNode,
): string {
  const normalizedWindowId = normalizeId(preferredWindowId);
  if (normalizedWindowId && placedWindowIds.has(normalizedWindowId)) return normalizedWindowId;
  return lastWorkspaceWindowId(root);
}

export function computeWorkspaceWindowRects(
  root: WorkspaceWindowLayoutNode | null | undefined,
): Map<string, WorkspaceWindowRect> {
  const rects = new Map<string, WorkspaceWindowRect>();
  if (!root) return rects;

  visitWorkspaceWindowRects(root, ROOT_RECT, rects);
  return rects;
}

export function moveWorkspaceWindow(
  root: WorkspaceWindowLayoutNode,
  draggedWindowId: string,
  targetWindowId: string,
  position: WorkspaceWindowDropPosition,
): WorkspaceWindowLayoutNode {
  const draggedId = normalizeId(draggedWindowId);
  const targetId = normalizeId(targetWindowId);
  if (!draggedId || !targetId || draggedId === targetId) return root;

  const windowIds = new Set(workspaceWindowIds(root));
  if (!windowIds.has(draggedId) || !windowIds.has(targetId)) return root;

  const withoutDraggedWindow = removeWorkspaceWindow(root, draggedId);
  if (!withoutDraggedWindow) return root;
  return insertWorkspaceWindow(withoutDraggedWindow, targetId, draggedId, position);
}

export function workspaceWindowDropPosition(
  rect: WorkspaceWindowRect,
  point: Pick<WorkspaceWindowRect, "x" | "y">,
): WorkspaceWindowDropPosition {
  if (rect.height > rect.width) {
    return point.y < rect.y + rect.height / 2 ? "top" : "bottom";
  }
  return point.x < rect.x + rect.width / 2 ? "left" : "right";
}

export function findWorkspaceWindowInDirection(
  rects: ReadonlyMap<string, WorkspaceWindowRect>,
  currentWindowId: string,
  direction: WorkspaceWindowDirection,
): string | null {
  const current = rects.get(currentWindowId);
  if (!current) return null;

  const candidates = [...rects.entries()].flatMap(([id, rect]) => {
    if (id === currentWindowId || !isRectInDirection(current, rect, direction)) return [];
    return [{ id, rect, score: directionalScore(current, rect, direction) }];
  });

  candidates.sort((left, right) => {
    for (let index = 0; index < left.score.length; index += 1) {
      const difference = left.score[index] - right.score[index];
      if (difference !== 0) return difference;
    }
    return left.id.localeCompare(right.id);
  });

  return candidates[0]?.id ?? null;
}

export function workspaceWindowIds(root: WorkspaceWindowLayoutNode): string[] {
  if (root.type === "leaf") return [root.id];
  return [...workspaceWindowIds(root.first), ...workspaceWindowIds(root.second)];
}

function chooseWorkspaceWindowSplitAxis(
  rect: WorkspaceWindowRect,
  options: Pick<ReconcileWorkspaceWindowLayoutOptions, "viewportWidth" | "viewportHeight">,
): WorkspaceWindowSplitAxis {
  const width = rect.width * positiveDimension(options.viewportWidth);
  const height = rect.height * positiveDimension(options.viewportHeight);
  return height > width ? "x" : "y";
}

function splitWorkspaceWindow(
  node: WorkspaceWindowLayoutNode,
  targetWindowId: string,
  newWindowId: string,
  axis: WorkspaceWindowSplitAxis,
): WorkspaceWindowLayoutNode {
  if (node.type === "leaf") {
    if (node.id !== targetWindowId) return node;
    return {
      type: "split",
      axis,
      first: node,
      second: { type: "leaf", id: newWindowId },
    };
  }

  return {
    ...node,
    first: splitWorkspaceWindow(node.first, targetWindowId, newWindowId, axis),
    second: splitWorkspaceWindow(node.second, targetWindowId, newWindowId, axis),
  };
}

function pruneWorkspaceWindowLayout(
  node: WorkspaceWindowLayoutNode,
  allowedWindowIds: ReadonlySet<string>,
  placedWindowIds: Set<string>,
): WorkspaceWindowLayoutNode | null {
  if (node.type === "leaf") {
    if (!allowedWindowIds.has(node.id) || placedWindowIds.has(node.id)) return null;
    placedWindowIds.add(node.id);
    return node;
  }

  const first = pruneWorkspaceWindowLayout(node.first, allowedWindowIds, placedWindowIds);
  const second = pruneWorkspaceWindowLayout(node.second, allowedWindowIds, placedWindowIds);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function visitWorkspaceWindowRects(
  node: WorkspaceWindowLayoutNode,
  rect: WorkspaceWindowRect,
  rects: Map<string, WorkspaceWindowRect>,
): void {
  if (node.type === "leaf") {
    rects.set(node.id, rect);
    return;
  }

  if (node.axis === "x") {
    const halfHeight = rect.height / 2;
    visitWorkspaceWindowRects(node.first, { ...rect, height: halfHeight }, rects);
    visitWorkspaceWindowRects(
      node.second,
      { ...rect, y: rect.y + halfHeight, height: halfHeight },
      rects,
    );
    return;
  }

  const halfWidth = rect.width / 2;
  visitWorkspaceWindowRects(node.first, { ...rect, width: halfWidth }, rects);
  visitWorkspaceWindowRects(
    node.second,
    { ...rect, x: rect.x + halfWidth, width: halfWidth },
    rects,
  );
}

function isRectInDirection(
  current: WorkspaceWindowRect,
  candidate: WorkspaceWindowRect,
  direction: WorkspaceWindowDirection,
): boolean {
  if (direction === "left") return candidate.x + candidate.width <= current.x;
  if (direction === "right") return candidate.x >= current.x + current.width;
  if (direction === "up") return candidate.y + candidate.height <= current.y;
  return candidate.y >= current.y + current.height;
}

function directionalScore(
  current: WorkspaceWindowRect,
  candidate: WorkspaceWindowRect,
  direction: WorkspaceWindowDirection,
): number[] {
  const horizontal = direction === "left" || direction === "right";
  const primaryGap = horizontal
    ? direction === "left"
      ? Math.max(0, current.x - (candidate.x + candidate.width))
      : Math.max(0, candidate.x - (current.x + current.width))
    : direction === "up"
      ? Math.max(0, current.y - (candidate.y + candidate.height))
      : Math.max(0, candidate.y - (current.y + current.height));
  const orthogonalGap = horizontal
    ? intervalGap(
        current.y,
        current.y + current.height,
        candidate.y,
        candidate.y + candidate.height,
      )
    : intervalGap(current.x, current.x + current.width, candidate.x, candidate.x + candidate.width);
  const orthogonalCenterDistance = horizontal
    ? Math.abs(current.y + current.height / 2 - (candidate.y + candidate.height / 2))
    : Math.abs(current.x + current.width / 2 - (candidate.x + candidate.width / 2));
  const centerDistance = Math.hypot(
    current.x + current.width / 2 - (candidate.x + candidate.width / 2),
    current.y + current.height / 2 - (candidate.y + candidate.height / 2),
  );

  return [
    orthogonalGap > 0 ? 1 : 0,
    primaryGap,
    orthogonalGap,
    orthogonalCenterDistance,
    centerDistance,
  ];
}

function intervalGap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): number {
  if (secondEnd < firstStart) return firstStart - secondEnd;
  if (secondStart > firstEnd) return secondStart - firstEnd;
  return 0;
}

function removeWorkspaceWindow(
  node: WorkspaceWindowLayoutNode,
  windowId: string,
): WorkspaceWindowLayoutNode | null {
  if (node.type === "leaf") return node.id === windowId ? null : node;

  const first = removeWorkspaceWindow(node.first, windowId);
  const second = removeWorkspaceWindow(node.second, windowId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function insertWorkspaceWindow(
  node: WorkspaceWindowLayoutNode,
  targetWindowId: string,
  draggedWindowId: string,
  position: WorkspaceWindowDropPosition,
): WorkspaceWindowLayoutNode {
  if (node.type === "leaf") {
    if (node.id !== targetWindowId) return node;
    const dragged: WorkspaceWindowLeaf = { type: "leaf", id: draggedWindowId };
    const draggedFirst = position === "top" || position === "left";
    return {
      type: "split",
      axis: position === "top" || position === "bottom" ? "x" : "y",
      first: draggedFirst ? dragged : node,
      second: draggedFirst ? node : dragged,
    };
  }

  return {
    ...node,
    first: insertWorkspaceWindow(node.first, targetWindowId, draggedWindowId, position),
    second: insertWorkspaceWindow(node.second, targetWindowId, draggedWindowId, position),
  };
}

function lastWorkspaceWindowId(root: WorkspaceWindowLayoutNode): string {
  if (root.type === "leaf") return root.id;
  return lastWorkspaceWindowId(root.second);
}

function uniqueWindowIds(values: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = normalizeId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function parseLayoutNode(
  value: unknown,
  windowIds: Set<string>,
  depth: number,
): WorkspaceWindowLayoutNode | null {
  if (!isRecord(value) || depth > MAX_LAYOUT_DEPTH) return null;
  if (value.type === "leaf") return parseLayoutLeaf(value.id, windowIds);
  if (value.type !== "split" || !isWorkspaceWindowSplitAxis(value.axis)) return null;
  return parseLayoutSplit(value, value.axis, windowIds, depth);
}

function parseLayoutLeaf(value: unknown, windowIds: Set<string>): WorkspaceWindowLeaf | null {
  const id = normalizeId(value);
  if (!id || windowIds.has(id)) return null;
  windowIds.add(id);
  return { type: "leaf", id };
}

function parseLayoutSplit(
  value: Record<string, unknown>,
  axis: WorkspaceWindowSplitAxis,
  windowIds: Set<string>,
  depth: number,
): WorkspaceWindowLayoutNode | null {
  const first = parseLayoutNode(value.first, windowIds, depth + 1);
  const second = parseLayoutNode(value.second, windowIds, depth + 1);
  if (!first) return second;
  if (!second) return first;
  return { type: "split", axis, first, second };
}

function isWorkspaceWindowSplitAxis(value: unknown): value is WorkspaceWindowSplitAxis {
  return value === "x" || value === "y";
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : null;
}

function positiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
