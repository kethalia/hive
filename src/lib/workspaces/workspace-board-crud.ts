import { isSafeCloneRelativePath } from "@/lib/git/clone-public-identifiers";
import {
  WORKSPACE_BOARD_STATE_VERSION,
  type WorkspaceBoard,
  type WorkspaceBoardPane,
  type WorkspaceBoardState,
  type WorkspaceBoardStateDiagnostic,
} from "@/lib/workspaces/workspace-board-state";

export interface AddWorkspaceBoardTerminalPaneInput {
  key?: string | null;
  sessionName?: string | null;
  label?: string | null;
}

export interface AddWorkspaceBoardGitPaneInput {
  key?: string | null;
  cloneSessionKey?: string | null;
  relativePath?: string | null;
  sessionName?: string | null;
  label?: string | null;
}

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

export function addTerminalPaneToActiveWorkspaceBoard(
  state: WorkspaceBoardState,
  pane: AddWorkspaceBoardTerminalPaneInput,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const sessionName = normalizeText(pane?.sessionName);
  if (!sessionName || !normalized.activeBoardKey) return normalized;

  const label = normalizeText(pane?.label);
  return addPaneToBoard(normalized, normalized.activeBoardKey, {
    kind: "terminal",
    key: normalizeText(pane?.key) ?? `terminal:${sessionName}`,
    sessionName,
    ...(label ? { label } : {}),
    order: 0,
  });
}

export function addGitPaneToActiveWorkspaceBoard(
  state: WorkspaceBoardState,
  pane: AddWorkspaceBoardGitPaneInput,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const cloneSessionKey = normalizeText(pane?.cloneSessionKey);
  const relativePath = normalizeRelativePath(pane?.relativePath);
  if (!cloneSessionKey || !relativePath || !normalized.activeBoardKey) return normalized;

  const sessionName = normalizeText(pane?.sessionName);
  const label = normalizeText(pane?.label);
  return addPaneToBoard(normalized, normalized.activeBoardKey, {
    kind: "git",
    key: normalizeText(pane?.key) ?? `git:${cloneSessionKey}:${relativePath}`,
    cloneSessionKey,
    relativePath,
    ...(sessionName ? { sessionName } : {}),
    ...(label ? { label } : {}),
    order: 0,
  });
}

export function removeWorkspaceBoardPane(
  state: WorkspaceBoardState,
  boardKey: string | null | undefined,
  paneKey: string | null | undefined,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const key = normalizeText(boardKey);
  const paneKeyToRemove = normalizeText(paneKey);
  if (!key || !paneKeyToRemove || !normalized.boards.some((board) => board.key === key)) {
    return normalized;
  }

  let paneRemoved = false;
  const boards = normalizeBoardOrder(
    normalized.boards.map((board) => {
      if (board.key !== key) return board;
      const panes = board.panes.filter((pane) => {
        const keep = pane.key !== paneKeyToRemove;
        if (!keep) paneRemoved = true;
        return keep;
      });
      return {
        ...board,
        activePaneKey: normalizeActivePaneKey(board.activePaneKey, panes),
        panes,
      };
    }),
  );

  if (!paneRemoved) return normalized;
  return { ...normalized, boards };
}

export function removeWorkspaceBoardPaneIdentity(
  state: WorkspaceBoardState,
  boardKey: string | null | undefined,
  paneKey: string | null | undefined,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const key = normalizeText(boardKey);
  const paneKeyToMatch = normalizeText(paneKey);
  const board = key ? normalized.boards.find((candidate) => candidate.key === key) : undefined;
  const targetPane = paneKeyToMatch
    ? board?.panes.find((candidate) => candidate.key === paneKeyToMatch)
    : undefined;
  if (!key || !board || !targetPane) return normalized;

  const identityToRemove = paneIdentity(targetPane);
  let paneRemoved = false;
  const boards = normalizeBoardOrder(
    normalized.boards.map((candidate) => {
      if (candidate.key !== key) return candidate;
      const panes = candidate.panes.filter((pane) => {
        const keep = paneIdentity(pane) !== identityToRemove;
        if (!keep) paneRemoved = true;
        return keep;
      });
      return {
        ...candidate,
        activePaneKey: normalizeActivePaneKey(candidate.activePaneKey, panes),
        panes,
      };
    }),
  );

  if (!paneRemoved) return normalized;
  return { ...normalized, boards };
}

export function selectWorkspaceBoardPane(
  state: WorkspaceBoardState,
  boardKey: string | null | undefined,
  paneKey: string | null | undefined,
): WorkspaceBoardState {
  const normalized = normalizeWorkspaceBoardStateForCrud(state);
  const key = normalizeText(boardKey);
  const activePaneKey = normalizeText(paneKey);
  const board = key ? normalized.boards.find((candidate) => candidate.key === key) : undefined;
  if (!board || !activePaneKey || !board.panes.some((pane) => pane.key === activePaneKey)) {
    return normalized;
  }

  return {
    ...normalized,
    activeBoardKey: key,
    boards: normalizeBoardOrder(
      normalized.boards.map((candidate) =>
        candidate.key === key ? { ...candidate, activePaneKey } : candidate,
      ),
    ),
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

function addPaneToBoard(
  state: WorkspaceBoardState,
  boardKey: string,
  pane: WorkspaceBoardPane,
): WorkspaceBoardState {
  const boards = normalizeBoardOrder(
    state.boards.map((board) => {
      if (board.key !== boardKey) return board;
      const matchingPane = board.panes.find(
        (candidate) => paneIdentity(candidate) === paneIdentity(pane),
      );
      if (matchingPane) {
        return {
          ...board,
          activePaneKey: matchingPane.key,
        };
      }
      const panes = [
        ...board.panes,
        {
          ...pane,
          key: uniquePaneKey(pane.key, board.panes),
          order: board.panes.length,
        },
      ];
      return {
        ...board,
        activePaneKey: panes[panes.length - 1]?.key,
        panes,
      };
    }),
  );

  return {
    ...state,
    boards,
  };
}

function paneIdentity(pane: WorkspaceBoardPane): string {
  if (pane.kind === "git") return `git:${pane.cloneSessionKey}:${pane.relativePath}`;
  return `terminal:${pane.sessionName}`;
}

function uniquePaneKey(
  requestedKey: string,
  panes: readonly Pick<WorkspaceBoardPane, "key">[],
): string {
  const existingKeys = new Set(panes.map((pane) => pane.key));
  if (!existingKeys.has(requestedKey)) return requestedKey;

  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${requestedKey}-${suffix}`;
    if (!existingKeys.has(candidate)) return candidate;
  }

  return `${requestedKey}-${panes.length + 1}`;
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
  const existingNames = new Set(boards.map((board) => board.name.toLowerCase()));
  if (!existingNames.has(baseName.toLowerCase())) return baseName;

  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
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
    .toLowerCase()
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

function normalizeRelativePath(value: unknown): string | undefined {
  const relativePath = normalizeText(value);
  if (
    !relativePath ||
    relativePath === "~" ||
    relativePath.startsWith("~/") ||
    relativePath.startsWith("~\\") ||
    /^[A-Za-z]:[\\/]/.test(relativePath) ||
    !isSafeCloneRelativePath(relativePath)
  ) {
    return undefined;
  }
  return relativePath;
}

function finiteNumberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
