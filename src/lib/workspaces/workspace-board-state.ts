export const WORKSPACE_BOARD_STATE_VERSION = 1;

export type WorkspaceBoardStorageSource = "workspace" | "unified" | "git";
export type WorkspaceBoardPaneKind = "terminal" | "git";

export interface WorkspaceBoardStateDiagnostic {
  code:
    | "persisted-json-invalid"
    | "persisted-version-unsupported"
    | "persisted-board-state-malformed"
    | "legacy-layout-migrated"
    | "board-repaired"
    | "pane-repaired"
    | "stale-pane-dropped"
    | "unsafe-pane-metadata-redacted";
  message: string;
  boardKey?: string;
  paneKey?: string;
  count?: number;
}

interface WorkspaceBoardPaneBase {
  kind: WorkspaceBoardPaneKind;
  key: string;
  label?: string;
  order: number;
}

export interface WorkspaceBoardTerminalPane extends WorkspaceBoardPaneBase {
  kind: "terminal";
  sessionName: string;
}

export interface WorkspaceBoardGitPane extends WorkspaceBoardPaneBase {
  kind: "git";
  cloneSessionKey: string;
  relativePath: string;
  sessionName?: string;
}

export type WorkspaceBoardPane = WorkspaceBoardTerminalPane | WorkspaceBoardGitPane;

export interface WorkspaceBoard {
  key: string;
  name: string;
  order: number;
  activePaneKey?: string;
  panes: WorkspaceBoardPane[];
}

export interface WorkspaceBoardState {
  version: typeof WORKSPACE_BOARD_STATE_VERSION;
  activeBoardKey?: string;
  boards: WorkspaceBoard[];
  diagnostics: WorkspaceBoardStateDiagnostic[];
}

export type PersistedWorkspaceBoardState = Omit<WorkspaceBoardState, "diagnostics">;

export type PersistedWorkspaceBoardStateParseResult =
  | { status: "unavailable"; state: null; diagnostics: WorkspaceBoardStateDiagnostic[] }
  | { status: "valid"; state: WorkspaceBoardState; diagnostics: WorkspaceBoardStateDiagnostic[] }
  | { status: "invalid"; state: null; diagnostics: WorkspaceBoardStateDiagnostic[] };

interface IndexedValue<T> {
  value: T;
  index: number;
}

export function workspaceBoardStorageKey(
  workspaceId: string,
  source: WorkspaceBoardStorageSource,
): string {
  const storageSource = source === "workspace" ? "workspace" : "git";
  return `workspace-board-state:${storageSource}:${workspaceId}`;
}

export function parsePersistedWorkspaceBoardState(
  persistedJson?: string | null,
): PersistedWorkspaceBoardStateParseResult {
  if (typeof persistedJson !== "string" || persistedJson.trim().length === 0) {
    return { status: "unavailable", state: null, diagnostics: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(persistedJson);
  } catch {
    return {
      status: "invalid",
      state: null,
      diagnostics: [
        {
          code: "persisted-json-invalid",
          message:
            "Stored workspace board state JSON could not be parsed; default board state was used.",
        },
      ],
    };
  }

  if (!isRecord(parsed)) {
    return invalidMalformed(
      "Stored workspace board state was not an object; default board state was used.",
    );
  }

  if (parsed.version !== WORKSPACE_BOARD_STATE_VERSION) {
    return {
      status: "invalid",
      state: null,
      diagnostics: [
        {
          code: "persisted-version-unsupported",
          message:
            "Stored workspace board state version is unsupported; default board state was used.",
        },
      ],
    };
  }

  if (!Array.isArray(parsed.boards)) {
    return invalidMalformed(
      "Stored workspace board state boards were malformed; default board state was used.",
    );
  }

  const diagnostics: WorkspaceBoardStateDiagnostic[] = [];
  const boards = normalizeBoards(parsed.boards, diagnostics);
  const activeBoardKey = normalizeActiveBoardKey(parsed.activeBoardKey, boards);
  const stateDiagnostics = [...diagnostics];

  return {
    status: "valid",
    state: {
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey,
      boards,
      diagnostics: stateDiagnostics,
    },
    diagnostics: stateDiagnostics,
  };
}

export function serializeWorkspaceBoardState(
  state: WorkspaceBoardState | null | undefined,
): string {
  const boards = (state?.boards ?? []).map((board): WorkspaceBoard => {
    const activePaneKey = normalizeActivePaneKey(board.activePaneKey, board.panes);
    return {
      key: board.key,
      name: board.name,
      order: board.order,
      ...(activePaneKey ? { activePaneKey } : {}),
      panes: board.panes.map(serializePane),
    };
  });
  const activeBoardKey = normalizeActiveBoardKey(state?.activeBoardKey, boards);

  return JSON.stringify({
    version: WORKSPACE_BOARD_STATE_VERSION,
    ...(activeBoardKey ? { activeBoardKey } : {}),
    boards,
  } satisfies PersistedWorkspaceBoardState);
}

function invalidMalformed(message: string): PersistedWorkspaceBoardStateParseResult {
  return {
    status: "invalid",
    state: null,
    diagnostics: [
      {
        code: "persisted-board-state-malformed",
        message,
      },
    ],
  };
}

function normalizeBoards(
  values: readonly unknown[],
  diagnostics: WorkspaceBoardStateDiagnostic[],
): WorkspaceBoard[] {
  const boards: IndexedValue<WorkspaceBoard>[] = [];
  const seenKeys = new Set<string>();

  values.forEach((value, index) => {
    if (!isRecord(value)) {
      diagnostics.push({
        code: "board-repaired",
        message: "A malformed workspace board was dropped.",
      });
      return;
    }

    const key = normalizeText(value.key);
    if (!key || seenKeys.has(key)) {
      diagnostics.push({
        code: "board-repaired",
        message: "A workspace board with a missing or duplicate key was dropped.",
        boardKey: key || undefined,
      });
      return;
    }
    seenKeys.add(key);

    const panes = Array.isArray(value.panes) ? normalizePanes(value.panes, key, diagnostics) : [];
    if (!Array.isArray(value.panes)) {
      diagnostics.push({
        code: "board-repaired",
        message: "A workspace board with malformed panes was repaired with an empty pane list.",
        boardKey: key,
      });
    }

    boards.push({
      index,
      value: {
        key,
        name: normalizeText(value.name) ?? `Board ${index + 1}`,
        order: 0,
        activePaneKey: normalizeActivePaneKey(value.activePaneKey, panes),
        panes,
      },
    });
  });

  return boards
    .sort(compareByPersistedOrder(values, (board) => board.key))
    .map(({ value }, order) => ({ ...value, order }));
}

function normalizePanes(
  values: readonly unknown[],
  boardKey: string,
  diagnostics: WorkspaceBoardStateDiagnostic[],
): WorkspaceBoardPane[] {
  const panes: IndexedValue<WorkspaceBoardPane>[] = [];
  const seenKeys = new Set<string>();

  values.forEach((value, index) => {
    if (!isRecord(value)) {
      diagnostics.push({
        code: "pane-repaired",
        message: "A malformed workspace board pane was dropped.",
        boardKey,
      });
      return;
    }

    const pane = normalizePane(value, boardKey, index, diagnostics);
    if (!pane) return;
    if (seenKeys.has(pane.key)) {
      diagnostics.push({
        code: "pane-repaired",
        message: "A workspace board pane with a duplicate key was dropped.",
        boardKey,
        paneKey: pane.key,
      });
      return;
    }
    seenKeys.add(pane.key);
    panes.push({ value: pane, index });
  });

  return panes
    .sort(compareByPersistedOrder(values, (pane) => pane.key))
    .map(({ value }, order) => ({ ...value, order }));
}

function normalizePane(
  value: Record<string, unknown>,
  boardKey: string,
  index: number,
  diagnostics: WorkspaceBoardStateDiagnostic[],
): WorkspaceBoardPane | null {
  const kind = value.kind === "git" ? "git" : value.kind === "terminal" ? "terminal" : null;
  if (!kind) {
    diagnostics.push({
      code: "pane-repaired",
      message: "A workspace board pane with an unsupported kind was dropped.",
      boardKey,
    });
    return null;
  }

  if (kind === "terminal") {
    const sessionName = normalizeText(value.sessionName);
    if (!sessionName) {
      diagnostics.push({
        code: "pane-repaired",
        message: "A terminal workspace board pane without a session name was dropped.",
        boardKey,
      });
      return null;
    }
    const key = normalizeText(value.key) ?? `terminal:${sessionName}`;
    return {
      kind,
      key,
      sessionName,
      label: normalizeText(value.label),
      order: finiteNumberOrFallback(value.order, index),
    };
  }

  const cloneSessionKey = normalizeText(value.cloneSessionKey);
  const relativePath = normalizeRelativePath(value.relativePath);
  if (!cloneSessionKey || !relativePath) {
    diagnostics.push({
      code: "pane-repaired",
      message: "A Git workspace board pane without safe Git refs was dropped.",
      boardKey,
    });
    return null;
  }
  const key = normalizeText(value.key) ?? `git:${cloneSessionKey}`;
  return {
    kind,
    key,
    cloneSessionKey,
    relativePath,
    sessionName: normalizeText(value.sessionName),
    label: normalizeText(value.label),
    order: finiteNumberOrFallback(value.order, index),
  };
}

function serializePane(pane: WorkspaceBoardPane): WorkspaceBoardPane {
  if (pane.kind === "terminal") {
    return {
      kind: "terminal",
      key: pane.key,
      sessionName: pane.sessionName,
      ...(pane.label ? { label: pane.label } : {}),
      order: pane.order,
    };
  }

  return {
    kind: "git",
    key: pane.key,
    ...(pane.sessionName ? { sessionName: pane.sessionName } : {}),
    ...(pane.label ? { label: pane.label } : {}),
    cloneSessionKey: pane.cloneSessionKey,
    relativePath: pane.relativePath,
    order: pane.order,
  };
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

function compareByPersistedOrder<T extends { value: { order: number }; index: number }>(
  originalValues: readonly unknown[],
  keyOf: (value: T["value"]) => string,
): (left: T, right: T) => number {
  return (left, right) => {
    const leftOriginal = originalValues[left.index];
    const rightOriginal = originalValues[right.index];
    const leftOrder = finiteNumberOrFallback(
      isRecord(leftOriginal) ? leftOriginal.order : undefined,
      left.index,
    );
    const rightOrder = finiteNumberOrFallback(
      isRecord(rightOriginal) ? rightOriginal.order : undefined,
      right.index,
    );
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.index !== right.index) return left.index - right.index;
    return keyOf(left.value).localeCompare(keyOf(right.value));
  };
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRelativePath(value: unknown): string | undefined {
  const relativePath = normalizeText(value);
  if (!relativePath || relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    return undefined;
  }
  return relativePath;
}

function finiteNumberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
