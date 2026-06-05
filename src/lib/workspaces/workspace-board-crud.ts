import {
  WORKSPACE_BOARD_STATE_VERSION,
  type WorkspaceBoard,
  type WorkspaceBoardPane,
  type WorkspaceBoardState,
  type WorkspaceBoardStateDiagnostic,
} from "@/lib/workspaces/workspace-board-state";

export function createWorkspaceBoard(
  state: WorkspaceBoardState,
  requestedName?: string | null,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const name = uniqueBoardName(
    normalizeText(requestedName) ?? `Board ${normalized.boards.length + 1}`,
    normalized.boards,
  );
  const key = uniqueBoardKey(slugifyBoardKey(name), normalized.boards);
  const boards = normalizeBoardOrder([
    ...normalized.boards,
    {
      key,
      name,
      order: normalized.boards.length,
      panes: [],
    },
  ]);

  return {
    version: WORKSPACE_BOARD_STATE_VERSION,
    activeBoardKey: key,
    boards,
    diagnostics: [...normalized.diagnostics],
  };
}

export function renameWorkspaceBoard(
  state: WorkspaceBoardState,
  boardKey: string | null | undefined,
  requestedName: string | null | undefined,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const key = normalizeText(boardKey);
  const name = normalizeText(requestedName);
  if (!key || !name || !normalized.boards.some((board) => board.key === key)) {
    return normalized;
  }

  const boardsWithoutRenamed = normalized.boards.filter((board) => board.key !== key);
  const uniqueName = uniqueBoardName(name, boardsWithoutRenamed);
  return {
    ...normalized,
    boards: normalizeBoardOrder(
      normalized.boards.map((board) =>
        board.key === key
          ? {
              ...board,
              name: uniqueName,
            }
          : board,
      ),
    ),
  };
}

export function renameActiveWorkspaceBoard(
  state: WorkspaceBoardState,
  requestedName: string | null | undefined,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  return renameWorkspaceBoard(normalized, normalized.activeBoardKey, requestedName);
}

export function deleteWorkspaceBoard(
  state: WorkspaceBoardState,
  boardKey: string | null | undefined,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const key = normalizeText(boardKey);
  const deleteIndex = key ? normalized.boards.findIndex((board) => board.key === key) : -1;
  if (deleteIndex < 0 || normalized.boards.length <= 1) {
    return normalized;
  }

  const remaining = normalized.boards.filter((board) => board.key !== key);
  const fallbackActiveBoardKey =
    normalized.activeBoardKey === key
      ? remaining[Math.min(deleteIndex, remaining.length - 1)]?.key
      : normalized.activeBoardKey;
  const boards = normalizeBoardOrder(remaining);

  return {
    ...normalized,
    activeBoardKey: normalizeActiveBoardKey(fallbackActiveBoardKey, boards),
    boards,
  };
}

export function selectWorkspaceBoard(
  state: WorkspaceBoardState,
  boardKey: string | null | undefined,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const key = normalizeText(boardKey);
  if (!key || !normalized.boards.some((board) => board.key === key)) {
    return normalized;
  }

  return {
    ...normalized,
    activeBoardKey: key,
  };
}

function normalizeWorkspaceBoardStateForCrud(state: WorkspaceBoardState): WorkspaceBoardState {
  const diagnostics = Array.isArray(state?.diagnostics)
    ? [...state.diagnostics]
    : ([] as WorkspaceBoardStateDiagnostic[]);
  const rawBoards = Array.isArray(state?.boards) ? state.boards : [];
  const boards = normalizeBoardOrder(rawBoards).filter(firstBoardWithKey());

  if (boards.length === 0) {
    const defaultBoard: WorkspaceBoard = {
      key: "default",
      name: "Default",
      order: 0,
      panes: [],
    };
    return {
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey: defaultBoard.key,
      boards: [defaultBoard],
      diagnostics,
    };
  }

  return {
    version: WORKSPACE_BOARD_STATE_VERSION,
    activeBoardKey: normalizeActiveBoardKey(state?.activeBoardKey, boards),
    boards,
    diagnostics,
  };
}

function normalizeBoardOrder(boards: readonly WorkspaceBoard[]): WorkspaceBoard[] {
  return boards
    .map((board, index) => ({ board, index }))
    .sort((left, right) => {
      const leftOrder = finiteNumberOrFallback(left.board.order, left.index);
      const rightOrder = finiteNumberOrFallback(right.board.order, right.index);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.index - right.index;
    })
    .map(({ board }, order) => ({
      key: normalizeText(board.key) ?? `board-${order + 1}`,
      name: normalizeText(board.name) ?? `Board ${order + 1}`,
      order,
      ...activePaneKeyObject(board.activePaneKey, board.panes),
      panes: normalizePaneOrder(board.panes),
    }));
}

function activePaneKeyObject(
  value: unknown,
  panes: readonly Pick<WorkspaceBoardPane, "key">[],
): Pick<WorkspaceBoard, "activePaneKey"> | Record<string, never> {
  const activePaneKey = normalizeActivePaneKey(value, panes);
  return activePaneKey ? { activePaneKey } : {};
}

function normalizePaneOrder(panes: readonly WorkspaceBoardPane[]): WorkspaceBoardPane[] {
  if (!Array.isArray(panes)) return [];
  return panes.map((pane, order) => ({ ...pane, order }));
}

function firstBoardWithKey(): (
  board: WorkspaceBoard,
  index: number,
  boards: WorkspaceBoard[],
) => boolean {
  const seen = new Set<string>();
  return (board) => {
    if (seen.has(board.key)) return false;
    seen.add(board.key);
    return true;
  };
}

function uniqueBoardName(requestedName: string, boards: readonly WorkspaceBoard[]): string {
  const baseName = normalizeText(requestedName) ?? "Board";
  const existingNames = new Set(boards.map((board) => board.name.toLocaleLowerCase()));
  if (!existingNames.has(baseName.toLocaleLowerCase())) return baseName;

  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!existingNames.has(candidate.toLocaleLowerCase())) return candidate;
  }

  return `${baseName} ${boards.length + 1}`;
}

function uniqueBoardKey(requestedKey: string, boards: readonly WorkspaceBoard[]): string {
  const baseKey = requestedKey || "board";
  const existingKeys = new Set(boards.map((board) => board.key));
  if (!existingKeys.has(baseKey)) return baseKey;

  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${baseKey}-${suffix}`;
    if (!existingKeys.has(candidate)) return candidate;
  }

  return `${baseKey}-${boards.length + 1}`;
}

function slugifyBoardKey(value: string): string {
  const slug = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "board";
}

function normalizeActiveBoardKey(
  value: unknown,
  boards: readonly Pick<WorkspaceBoard, "key">[],
): string | undefined {
  const activeBoardKey = normalizeText(value);
  if (!activeBoardKey) return boards[0]?.key;
  return boards.some((board) => board.key === activeBoardKey) ? activeBoardKey : boards[0]?.key;
}

function normalizeActivePaneKey(
  value: unknown,
  panes: readonly Pick<WorkspaceBoardPane, "key">[],
): string | undefined {
  const activePaneKey = normalizeText(value);
  if (!activePaneKey) return panes[0]?.key;
  return panes.some((pane) => pane.key === activePaneKey) ? activePaneKey : panes[0]?.key;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
