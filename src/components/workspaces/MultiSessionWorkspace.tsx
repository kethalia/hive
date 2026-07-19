"use client";

import type { Terminal } from "@xterm/xterm";
import { AlertCircle, ExternalLink, Loader2, Plus, Search, TerminalSquare } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CommandPalette, type CommandPaletteAction } from "@/components/terminal/CommandPalette";
import { MobileTerminalControls } from "@/components/terminal/MobileTerminalControls";
import { MobileTerminalShell } from "@/components/terminal/MobileTerminalShell";
import { TerminalSessionCompose } from "@/components/terminal/TerminalSessionCompose";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  TerminalFontSizeControls,
  TerminalSessionFrame,
} from "@/components/workspaces/TerminalSessionFrame";
import { WorkspaceBoardBar } from "@/components/workspaces/WorkspaceBoardBar";
import {
  isWorkspaceSessionToolUrls,
  WorkspaceSessionTools,
  type WorkspaceSessionToolUrls,
  type WorkspaceTool,
  type WorkspaceToolOpenRequest,
} from "@/components/workspaces/WorkspaceSessionTools";
import { useIsComposeSheet } from "@/hooks/use-compose-sheet";
import { useKeepAliveStatus } from "@/hooks/useKeepAliveStatus";
import { useKeybindings } from "@/hooks/useKeybindings";
import type { ConnectionState, TerminalRecoveryState } from "@/hooks/useTerminalWebSocket";
import { useVisualViewportKeyboardOffset } from "@/hooks/useVisualViewportKeyboardOffset";
import { listGitClonesAction, resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import {
  listNavigationFavoritesAction,
  type NavigationFavoriteDto,
} from "@/lib/actions/navigation-favorites";
import {
  createSessionAction,
  getWorkspaceSessionsAction,
  getWorkspaceSessionToolsAction,
  killSessionAction,
} from "@/lib/actions/workspaces";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import { triggerHapticFeedback } from "@/lib/device/haptics";
import type { GitCloneTerminalIdentity, PublicCloneTree } from "@/lib/git/clone-actions-contract";
import type { CloneTreeNode, CloneTreeRepositoryNode } from "@/lib/git/clone-tree";
import {
  eventTargetElement,
  isTerminalHelperTextAreaTarget,
  isTextEntryEventTarget,
} from "@/lib/keyboard-event-targets";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import {
  type ClipboardActionStatus,
  copyTerminalSelection,
  pasteClipboardApiToTerminal,
} from "@/lib/terminal/actions";
import type { TerminalComposeRequest, TerminalPasteStatus } from "@/lib/terminal/clipboard";
import { TERMINAL_COMPOSE_TOGGLE_EVENT } from "@/lib/terminal/events";
import { registerGlobalCommandPaletteSource } from "@/lib/terminal/global-command-palette";
import { isPwaStandalone } from "@/lib/terminal/pwa";
import { cn } from "@/lib/utils";
import {
  type PersistedSessionPane,
  resolveSessionPaneLayout,
  SESSION_PANE_LAYOUT_VERSION,
  type SessionPane,
  type SessionPaneLayoutDiagnostic,
} from "@/lib/workspaces/session-pane-layout";
import {
  addGitPaneToActiveWorkspaceBoard,
  addTerminalPaneToActiveWorkspaceBoard,
  createWorkspaceBoard,
  deleteWorkspaceBoard,
  removeWorkspaceBoardPaneIdentity,
  selectWorkspaceBoard,
  selectWorkspaceBoardPane,
} from "@/lib/workspaces/workspace-board-crud";
import {
  parsePersistedWorkspaceBoardState,
  resolveWorkspaceBoardState,
  serializeWorkspaceBoardState,
  type WorkspaceBoard,
  type WorkspaceBoardFallbackPane,
  type WorkspaceBoardPane,
  type WorkspaceBoardState,
  type WorkspaceBoardStateDiagnostic,
  workspaceBoardStorageKey,
} from "@/lib/workspaces/workspace-board-state";
import {
  summarizeWorkspacePaneRecovery,
  type WorkspaceGitPaneRefreshInput,
  type WorkspacePaneRecoveryInput,
} from "@/lib/workspaces/workspace-pane-recovery";

interface InteractiveTerminalComponentProps {
  agentId: string;
  workspaceId: string;
  sessionName: string;
  clonePath?: string;
  cloneProof?: string;
  refreshCloneTerminalIdentity?: (context: {
    sessionName: string;
    clonePath: string;
    reason: "scheduled-reconnect" | "manual-reconnect";
    retryCount: number;
    closeCode: number | null;
    closeCategory: string | null;
    reasonCategory: string | null;
  }) => Promise<{ sessionName: string; clonePath: string; cloneProof: string }>;
  className?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onRecoveryStateChange?: (state: TerminalRecoveryState) => void;
  onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
  onTerminalDestroy?: () => void;
  onUserFocusRequest?: () => void;
  onComposeRequest?: (request: TerminalComposeRequest) => void;
  onClipboardStatus?: (status: TerminalPasteStatus) => void;
  targetLabel?: string;
  layoutSignal?: unknown;
  mobileInputMode?: boolean;
  suppressAutoFocus?: boolean;
  pinToBottomOnResize?: boolean;
  selectionModeEnabled?: boolean;
}

const InteractiveTerminal = dynamic<InteractiveTerminalComponentProps>(
  () => import("@/components/workspaces/InteractiveTerminal").then((m) => m.InteractiveTerminal),
  { ssr: false },
);

interface WorkspaceSessionPane {
  sessionName: string;
  label: string;
  clonePath?: string;
  cloneProof?: string;
  cloneSessionKey?: string;
  relativePath?: string;
}

interface VisibleWorkspaceSessionPane extends WorkspaceSessionPane {
  boardPaneKey: string;
  boardPaneKind: WorkspaceBoardPane["kind"];
}

interface WorkspaceBoardRenderModel {
  board: WorkspaceBoard;
  isActive: boolean;
  visibleSessions: VisibleWorkspaceSessionPane[];
  toolPanes: WorkspaceToolPane[];
  layout: ReturnType<typeof resolveSessionPaneLayout>;
}

interface WorkspaceToolPane {
  key: string;
  boardKey: string;
  sourceSessionName: string;
  tool: WorkspaceTool;
  url: string;
  label: string;
  folderPath: string | null;
}

interface RemoveWorkspacePaneTarget {
  sessionName: string;
  boardKey?: string;
  boardPaneKey?: string;
}

interface GitRepositoryOption {
  cloneSessionKey: string;
  relativePath: string;
  label: string;
}

interface GitFavoriteRepositoryOption extends GitRepositoryOption {
  favoriteLabel: string;
}

interface TerminalEntry {
  term: Terminal;
  send: (data: string) => void;
}

interface MultiSessionWorkspaceProps {
  agentId: string;
  workspaceId: string;
  className?: string;
  source?: "workspace" | "unified";
}

type SessionLoadResult =
  | {
      status: "success";
      sessions: WorkspaceSessionPane[];
      repositories?: GitRepositoryOption[];
      gitRestoreFailed?: boolean;
    }
  | { status: "empty"; repositories?: GitRepositoryOption[]; gitRestoreFailed?: boolean }
  | { status: "failure"; repositories?: GitRepositoryOption[]; gitRestoreFailed?: boolean };

type CreateResult = { status: "success"; session: WorkspaceSessionPane } | { status: "failure" };

type PersistedWorkspaceSessionPane = PersistedSessionPane & {
  cloneSessionKey?: string;
  relativePath?: string;
  label?: string;
};

interface PersistedGitPaneRef {
  cloneSessionKey: string;
  relativePath: string;
  sessionName?: string;
  label?: string;
}

type LayoutPersistenceNotice = {
  code: "storage-unavailable" | "storage-write-failed" | "storage-reset-failed";
  message: string;
};

type BoardPersistenceNotice = {
  code: "storage-unavailable" | "storage-write-failed";
  message: string;
};

const CREATE_TERMINAL_SESSION_SHORTCUT_KEYS = ["ctrl+shift+n", "cmd+shift+n"] as const;
const CLOSE_TERMINAL_PANE_SHORTCUT_KEYS = ["ctrl+w"] as const;
const WORKSPACE_BOARD_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
type WorkspaceBoardIndex = (typeof WORKSPACE_BOARD_INDEXES)[number];

type WorkspaceShortcutEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "defaultPrevented"
  | "key"
  | "metaKey"
  | "preventDefault"
  | "shiftKey"
  | "target"
>;

function workspaceIndexFromShortcutEvent(
  event: WorkspaceShortcutEvent,
): WorkspaceBoardIndex | null {
  const codeMatch = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  const rawIndex = codeMatch?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
  if (!rawIndex) return null;
  return Number(rawIndex) as WorkspaceBoardIndex;
}

function workspaceArrowDirectionFromShortcutEvent(event: WorkspaceShortcutEvent): -1 | 1 | null {
  const key = event.key.toLowerCase();
  if (key === "arrowleft" || key === "left" || key === "arrowup" || key === "up") return -1;
  if (key === "arrowright" || key === "right" || key === "arrowdown" || key === "down") {
    return 1;
  }
  if (event.code === "ArrowLeft" || event.code === "ArrowUp") return -1;
  if (event.code === "ArrowRight" || event.code === "ArrowDown") return 1;
  return null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const GIT_TERMINAL_ADD_ERROR_TITLE = "Could not add Git terminal";
const GIT_TERMINAL_ADD_FALLBACK_MESSAGE =
  "Could not add Git terminal. No terminal contents or clone proof were logged.";

function firstActionErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstActionErrorMessage(item);
      if (message) return message;
    }
    return null;
  }

  if (!isObjectRecord(value)) return null;

  const directErrors = firstActionErrorMessage(value._errors);
  if (directErrors) return directErrors;

  const formErrors = firstActionErrorMessage(value.formErrors);
  if (formErrors) return formErrors;

  const fieldErrors = firstActionErrorMessage(value.fieldErrors);
  if (fieldErrors) return fieldErrors;

  for (const nested of Object.values(value)) {
    const message = firstActionErrorMessage(nested);
    if (message) return message;
  }

  return null;
}

function actionFailureMessage(result: unknown, fallback: string): string {
  if (!isObjectRecord(result)) return fallback;

  const serverError = firstActionErrorMessage(result.serverError);
  if (serverError) return serverError;

  const validationError = firstActionErrorMessage(result.validationErrors);
  if (validationError) return validationError;

  return fallback;
}

function normalizeSessionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSessionItem(value: unknown): WorkspaceSessionPane | null {
  if (!isObjectRecord(value)) return null;
  const sessionName = normalizeSessionName(value.name ?? value.sessionName);
  if (!sessionName) return null;
  return { sessionName, label: sessionName };
}

function isWorkspaceSessionPane(value: WorkspaceSessionPane | null): value is WorkspaceSessionPane {
  return value !== null;
}

function uniqueSessions(values: readonly WorkspaceSessionPane[]): WorkspaceSessionPane[] {
  const seen = new Set<string>();
  const unique: WorkspaceSessionPane[] = [];

  for (const value of values) {
    if (seen.has(value.sessionName)) continue;
    seen.add(value.sessionName);
    unique.push(value);
  }

  return unique;
}

function parseSessionsResult(result: unknown): SessionLoadResult {
  if (!isObjectRecord(result)) return { status: "failure" };
  if (result.serverError || result.validationErrors) return { status: "failure" };
  if (!Array.isArray(result.data)) return { status: "failure" };

  const sessions = uniqueSessions(
    result.data.map(normalizeSessionItem).filter(isWorkspaceSessionPane),
  );
  return sessions.length > 0 ? { status: "success", sessions } : { status: "empty" };
}

function parseCreateResult(result: unknown): CreateResult {
  if (!isObjectRecord(result)) return { status: "failure" };
  if (result.serverError || result.validationErrors) return { status: "failure" };
  if (!isObjectRecord(result.data)) return { status: "failure" };

  const sessionName = normalizeSessionName(result.data.name ?? result.data.sessionName);
  if (!sessionName) return { status: "failure" };
  return { status: "success", session: { sessionName, label: sessionName } };
}

function isGitCloneTerminalIdentity(value: unknown): value is GitCloneTerminalIdentity {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.sessionName === "string" &&
    value.sessionName.length > 0 &&
    typeof value.clonePath === "string" &&
    value.clonePath.length > 0 &&
    typeof value.cloneProof === "string" &&
    value.cloneProof.length > 0
  );
}

function terminalHasSelection(term: {
  hasSelection?: () => boolean;
  getSelection?: () => string;
}): boolean {
  if (typeof term.hasSelection === "function") return term.hasSelection();
  return Boolean(term.getSelection?.());
}

function clipboardStatusText(
  status: ClipboardActionStatus | null,
  {
    canPaste,
    hasTerminal,
    selectionModeEnabled,
  }: { canPaste: boolean; hasTerminal: boolean; selectionModeEnabled: boolean },
): string {
  if (status) {
    switch (status.action) {
      case "copy":
        return status.outcome === "copied" ? "Selection copied" : "Select terminal text to copy";
      case "paste":
        if (status.outcome === "uploading") return "Uploading pasted files...";
        if (status.outcome === "empty") return "Clipboard is empty";
        if (status.outcome === "failed") return status.message;
        if (status.outcome === "fallback") return "Use the browser paste control";
        return "Paste complete";
      default:
        return "Terminal controls ready";
    }
  }
  if (selectionModeEnabled) return "Selection mode on. Select terminal text, then copy.";
  if (!hasTerminal) return "Terminal is not ready";
  if (!canPaste) return "Paste is unavailable until the terminal sender is ready";
  return "Terminal controls ready";
}

function toastPasteError(status: ClipboardActionStatus): void {
  if (status.action !== "paste" || status.outcome !== "failed") return;
  toast.error(status.message ?? "Paste failed.");
}

function isPublicCloneTree(value: unknown): value is PublicCloneTree {
  return isObjectRecord(value) && Array.isArray(value.nodes);
}

function isNavigationFavoriteDto(value: unknown): value is NavigationFavoriteDto {
  return (
    isObjectRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "terminal" || value.kind === "git") &&
    typeof value.workspaceId === "string" &&
    typeof value.targetKey === "string" &&
    (typeof value.label === "string" || value.label === null) &&
    (typeof value.relativePath === "string" || value.relativePath === null) &&
    typeof value.createdAt === "string"
  );
}

function flattenRepositoryNodes(nodes: readonly CloneTreeNode[]): CloneTreeRepositoryNode[] {
  const repositories: CloneTreeRepositoryNode[] = [];

  for (const node of nodes) {
    if (node.kind === "repository") {
      repositories.push(node);
      continue;
    }
    repositories.push(...flattenRepositoryNodes(node.children));
  }

  return repositories;
}

function toGitRepositoryOption(repository: CloneTreeRepositoryNode): GitRepositoryOption {
  return {
    cloneSessionKey: repository.cloneSessionKey,
    relativePath: repository.relativePath,
    label: repository.relativePath || repository.label,
  };
}

function readPersistedGitPaneRefs(persistedJson: string | null): PersistedGitPaneRef[] {
  if (!persistedJson) return [];

  try {
    const parsed = JSON.parse(persistedJson) as unknown;
    if (!isObjectRecord(parsed)) return [];

    const paneValues: unknown[] = [];
    if (Array.isArray(parsed.panes)) {
      paneValues.push(...parsed.panes);
    }
    if (Array.isArray(parsed.boards)) {
      for (const board of parsed.boards) {
        if (isObjectRecord(board) && Array.isArray(board.panes)) {
          paneValues.push(...board.panes);
        }
      }
    }

    const seen = new Set<string>();
    return paneValues.flatMap((pane): PersistedGitPaneRef[] => {
      if (!isObjectRecord(pane)) return [];
      const cloneSessionKey = normalizeSessionName(pane.cloneSessionKey);
      const relativePath = normalizeSessionName(pane.relativePath);
      if (!cloneSessionKey || !relativePath) return [];
      const identity = gitPaneIdentity(cloneSessionKey, relativePath);
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [
        {
          cloneSessionKey,
          relativePath,
          sessionName: normalizeSessionName(pane.sessionName) ?? undefined,
          label: normalizeSessionName(pane.label) ?? relativePath,
        },
      ];
    });
  } catch {
    return [];
  }
}

function unwrapActionData(result: unknown): unknown {
  return isObjectRecord(result) && "data" in result ? result.data : result;
}

function storageKeyForWorkspace(workspaceId: string, source: "workspace" | "unified"): string {
  const storageSource = source === "unified" ? "git" : "workspace";
  return `multi-session-layout:${storageSource}:${workspaceId}`;
}

function readWorkspaceLayoutStorage(storageKey: string): {
  raw: string | null;
  notice: LayoutPersistenceNotice | null;
} {
  if (typeof window === "undefined") return { raw: null, notice: null };

  try {
    return { raw: window.localStorage.getItem(storageKey), notice: null };
  } catch {
    return {
      raw: null,
      notice: {
        code: "storage-unavailable",
        message: "Layout persistence is unavailable. Safe tiled layout is active.",
      },
    };
  }
}

function readWorkspaceBoardStorage(storageKey: string): {
  raw: string | null;
  notice: BoardPersistenceNotice | null;
} {
  if (typeof window === "undefined") return { raw: null, notice: null };

  try {
    return { raw: window.localStorage.getItem(storageKey), notice: null };
  } catch {
    return {
      raw: null,
      notice: {
        code: "storage-unavailable",
        message: "Board persistence is unavailable. Safe default board is active.",
      },
    };
  }
}

function parsePersistedActiveSessionName(persistedJson: string | null): string | null {
  if (!persistedJson) return null;

  try {
    const parsed = JSON.parse(persistedJson) as unknown;
    if (!isObjectRecord(parsed)) return null;
    return normalizeSessionName(parsed.activeSessionName);
  } catch {
    return null;
  }
}

function serializeWorkspacePaneLayout(
  panes: readonly PersistedWorkspaceSessionPane[],
  activeSessionName: string | null,
): string {
  return JSON.stringify({
    version: SESSION_PANE_LAYOUT_VERSION,
    activeSessionName: activeSessionName ?? undefined,
    panes,
  });
}

function hasValidPersistedBoardState(persistedBoardJson: string | null): boolean {
  const parsed = parsePersistedWorkspaceBoardState(persistedBoardJson);
  return parsed.status === "valid" && parsed.state.boards.length > 0;
}

function buildFallbackBoardPanes(
  sessions: readonly WorkspaceSessionPane[],
): WorkspaceBoardFallbackPane[] {
  return sessions.map((session, order): WorkspaceBoardFallbackPane => {
    if (session.cloneSessionKey && session.relativePath) {
      return {
        kind: "git",
        key: `git:${session.cloneSessionKey}:${session.relativePath}`,
        cloneSessionKey: session.cloneSessionKey,
        relativePath: session.relativePath,
        sessionName: session.sessionName,
        label: session.label,
        order,
      };
    }

    return {
      kind: "terminal",
      key: `terminal:${session.sessionName}`,
      sessionName: session.sessionName,
      label: session.label,
      order,
    };
  });
}

function findActiveWorkspaceBoard(state: WorkspaceBoardState): WorkspaceBoard | undefined {
  return state.boards.find((board) => board.key === state.activeBoardKey) ?? state.boards[0];
}

function orderedWorkspaceBoards(boards: readonly WorkspaceBoard[]): WorkspaceBoard[] {
  return boards
    .map((board, index) => ({ board, index }))
    .sort((left, right) => {
      const leftOrder = finiteNumberOrFallback(left.board.order, left.index);
      const rightOrder = finiteNumberOrFallback(right.board.order, right.index);
      return leftOrder === rightOrder ? left.index - right.index : leftOrder - rightOrder;
    })
    .map(({ board }) => board);
}

function finiteNumberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function gitPaneIdentity(cloneSessionKey: string, relativePath: string): string {
  return `${cloneSessionKey}\u0000${relativePath}`;
}

function gitPaneActionIdentity(cloneSessionKey: string, relativePath: string): string {
  return `${cloneSessionKey}:${relativePath}`;
}

function gitRepositoryActionIdentity(repository: GitRepositoryOption): string {
  return gitPaneActionIdentity(repository.cloneSessionKey, repository.relativePath);
}

function deriveVisibleSessionsFromBoard(
  sessions: readonly WorkspaceSessionPane[],
  activeBoard: WorkspaceBoard | undefined,
): VisibleWorkspaceSessionPane[] {
  if (!activeBoard) return [];

  const sessionByName = new Map(sessions.map((session) => [session.sessionName, session]));
  const gitSessionByIdentity = new Map(
    sessions.flatMap(
      (session): Array<[string, WorkspaceSessionPane]> =>
        session.cloneSessionKey && session.relativePath
          ? [[gitPaneIdentity(session.cloneSessionKey, session.relativePath), session]]
          : [],
    ),
  );
  const seenSessionNames = new Set<string>();
  const visibleSessions: VisibleWorkspaceSessionPane[] = [];

  for (const pane of activeBoard.panes) {
    const session =
      pane.kind === "git"
        ? (gitSessionByIdentity.get(gitPaneIdentity(pane.cloneSessionKey, pane.relativePath)) ??
          (pane.sessionName ? sessionByName.get(pane.sessionName) : undefined))
        : sessionByName.get(pane.sessionName);

    if (!session || seenSessionNames.has(session.sessionName)) continue;
    seenSessionNames.add(session.sessionName);
    visibleSessions.push({
      ...session,
      label: pane.label ?? session.label,
      boardPaneKey: pane.key,
      boardPaneKind: pane.kind,
    });
  }

  return visibleSessions;
}

function reconcileGitPaneSessionNames(
  state: WorkspaceBoardState,
  sessions: readonly WorkspaceSessionPane[],
): WorkspaceBoardState {
  const gitSessionNameByIdentity = new Map(
    sessions.flatMap(
      (session): Array<[string, string]> =>
        session.cloneSessionKey && session.relativePath
          ? [[gitPaneIdentity(session.cloneSessionKey, session.relativePath), session.sessionName]]
          : [],
    ),
  );

  return {
    ...state,
    boards: state.boards.map((board) => ({
      ...board,
      panes: board.panes.map((pane) => {
        if (pane.kind !== "git") return pane;
        const sessionName = gitSessionNameByIdentity.get(
          gitPaneIdentity(pane.cloneSessionKey, pane.relativePath),
        );
        return sessionName ? { ...pane, sessionName } : { ...pane, sessionName: undefined };
      }),
    })),
  };
}

function activeSessionNameForVisibleSessions(
  visibleSessions: readonly VisibleWorkspaceSessionPane[],
  activeBoard: WorkspaceBoard | undefined,
  preferredSessionName: string | null,
): string | null {
  if (
    preferredSessionName &&
    visibleSessions.some((session) => session.sessionName === preferredSessionName)
  ) {
    return preferredSessionName;
  }

  const activePaneSession = activeBoard?.activePaneKey
    ? visibleSessions.find((session) => session.boardPaneKey === activeBoard.activePaneKey)
    : undefined;
  return activePaneSession?.sessionName ?? visibleSessions[0]?.sessionName ?? null;
}

function isWorkspacePaneHealthy(pane: WorkspacePaneRecoveryInput | null | undefined): boolean {
  if (!pane || pane.connectionState !== "connected") return false;
  const phase = pane.recoveryState?.phase;
  return phase === undefined || phase === "idle" || phase === "connected";
}

function buildLayoutPersistenceMessage(
  notice: LayoutPersistenceNotice | null,
  diagnostics: readonly SessionPaneLayoutDiagnostic[],
): string | null {
  if (notice) return notice.message;
  if (diagnostics.some((diagnostic) => diagnostic.code === "persisted-json-invalid")) {
    return "Stored layout was unreadable. Safe tiled layout is active.";
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "persisted-version-unsupported")) {
    return "Stored layout version is unsupported. Safe tiled layout is active.";
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "persisted-layout-malformed")) {
    return "Stored layout was malformed. Safe tiled layout is active.";
  }
  return null;
}

function buildBoardPersistenceMessage(
  notice: BoardPersistenceNotice | null,
  diagnostics: readonly WorkspaceBoardStateDiagnostic[],
): string | null {
  if (notice) return notice.message;
  if (diagnostics.some((diagnostic) => diagnostic.code === "persisted-json-invalid")) {
    return "Stored board state was unreadable. Safe default board is active.";
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "persisted-version-unsupported")) {
    return "Stored board state version is unsupported. Safe default board is active.";
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "persisted-board-state-malformed")) {
    return "Stored board state was malformed. Safe default board is active.";
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "legacy-layout-migrated")) {
    return "Stored layout was migrated to workspace boards.";
  }
  if (
    diagnostics.some((diagnostic) =>
      [
        "board-repaired",
        "pane-repaired",
        "stale-pane-dropped",
        "unsafe-pane-metadata-redacted",
      ].includes(diagnostic.code),
    )
  ) {
    return "Stored board state was repaired. Safe board metadata is active.";
  }
  return null;
}

async function loadWorkspaceSessions(workspaceId: string): Promise<SessionLoadResult> {
  const result = await getWorkspaceSessionsAction({ workspaceId });
  return parseSessionsResult(result);
}

async function loadGitSessions(
  workspaceId: string,
  agentId: string,
  persistedJson: string | null,
): Promise<SessionLoadResult> {
  const discovery = unwrapActionData(await listGitClonesAction({ workspaceId }));
  if (!isObjectRecord(discovery) || discovery.ok !== true || !isPublicCloneTree(discovery.tree)) {
    return { status: "failure" };
  }

  const repositories = flattenRepositoryNodes(discovery.tree.nodes).map(toGitRepositoryOption);
  const persistedRefs = readPersistedGitPaneRefs(persistedJson);
  if (repositories.length === 0) {
    return { status: "empty", repositories, gitRestoreFailed: persistedRefs.length > 0 };
  }

  const repositoryByIdentity = new Map(
    repositories.map((repository) => [
      gitPaneIdentity(repository.cloneSessionKey, repository.relativePath),
      repository,
    ]),
  );
  const selectedRefs = persistedRefs.filter((ref) =>
    repositoryByIdentity.has(gitPaneIdentity(ref.cloneSessionKey, ref.relativePath)),
  );
  if (selectedRefs.length === 0) {
    return { status: "empty", repositories, gitRestoreFailed: persistedRefs.length > 0 };
  }

  const resolved = await Promise.allSettled(
    selectedRefs.map(async (ref): Promise<WorkspaceSessionPane | null> => {
      const repository = repositoryByIdentity.get(
        gitPaneIdentity(ref.cloneSessionKey, ref.relativePath),
      );
      if (!repository) return null;

      const identity = unwrapActionData(
        await resolveGitCloneTerminalAction({
          agentId,
          workspaceId,
          cloneSessionKey: ref.cloneSessionKey,
          relativePath: ref.relativePath,
        }),
      );
      if (!isGitCloneTerminalIdentity(identity)) return null;
      return {
        sessionName: identity.sessionName,
        label: ref.label ?? repository.label,
        clonePath: identity.clonePath,
        cloneProof: identity.cloneProof,
        cloneSessionKey: ref.cloneSessionKey,
        relativePath: ref.relativePath,
      };
    }),
  );

  const sessions = uniqueSessions(
    resolved.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    ),
  );
  const gitRestoreFailed = sessions.length < persistedRefs.length;

  return sessions.length > 0
    ? { status: "success", sessions, repositories, gitRestoreFailed }
    : { status: "empty", repositories, gitRestoreFailed };
}

async function loadUnifiedWorkspaceSessions(
  workspaceId: string,
  agentId: string,
  persistedJson: string | null,
): Promise<SessionLoadResult> {
  const [workspaceResult, gitResult] = await Promise.allSettled([
    loadWorkspaceSessions(workspaceId),
    loadGitSessions(workspaceId, agentId, persistedJson),
  ]);

  const workspaceLoad: SessionLoadResult =
    workspaceResult.status === "fulfilled" ? workspaceResult.value : { status: "failure" };
  const gitLoad: SessionLoadResult =
    gitResult.status === "fulfilled" ? gitResult.value : { status: "failure" };
  const repositories = "repositories" in gitLoad ? gitLoad.repositories : undefined;
  const sessions = uniqueSessions([
    ...(workspaceLoad.status === "success" ? workspaceLoad.sessions : []),
    ...(gitLoad.status === "success" ? gitLoad.sessions : []),
  ]);

  const gitRestoreFailed = gitLoad.status === "failure" || gitLoad.gitRestoreFailed === true;
  if (sessions.length > 0) return { status: "success", sessions, repositories, gitRestoreFailed };
  if (workspaceLoad.status === "failure") {
    return { status: "failure", repositories, gitRestoreFailed };
  }
  return { status: "empty", repositories, gitRestoreFailed };
}

export function MultiSessionWorkspace({
  agentId,
  workspaceId,
  className,
  source = "workspace",
}: MultiSessionWorkspaceProps) {
  const router = useRouter();
  const { register, setActiveTerminal, unregister } = useKeybindings();
  const [sessions, setSessions] = useState<WorkspaceSessionPane[]>([]);
  const [activeSessionName, setActiveSessionName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [gitRepositories, setGitRepositories] = useState<GitRepositoryOption[]>([]);
  const [gitFavorites, setGitFavorites] = useState<NavigationFavoriteDto[]>([]);
  const [gitFavoritesLoading, setGitFavoritesLoading] = useState(false);
  const [gitFavoritesFailed, setGitFavoritesFailed] = useState(false);
  const [gitSearchOpen, setGitSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState("");
  const [composeTargetSessionName, setComposeTargetSessionName] = useState<string | null>(null);
  const [composeTargetLabel, setComposeTargetLabel] = useState<string | undefined>();
  const [selectionModeEnabled, setSelectionModeEnabled] = useState(false);
  const [hasTerminalSelection, setHasTerminalSelection] = useState(false);
  const [clipboardActionStatus, setClipboardActionStatus] = useState<ClipboardActionStatus | null>(
    null,
  );
  const [terminalStateVersion, setTerminalStateVersion] = useState(0);
  const [gitSearchQuery, setGitSearchQuery] = useState("");
  const [addingCloneKey, setAddingCloneKey] = useState<string | null>(null);
  const [gitAddError, setGitAddError] = useState<string | null>(null);
  const [gitRestoreFailed, setGitRestoreFailed] = useState(false);
  const [terminalCloseFailed, setTerminalCloseFailed] = useState(false);
  const [persistedLayoutJson, setPersistedLayoutJson] = useState<string | null>(null);
  const [layoutPersistenceNotice, setLayoutPersistenceNotice] =
    useState<LayoutPersistenceNotice | null>(null);
  const [boardState, setBoardState] = useState<WorkspaceBoardState>(() =>
    resolveWorkspaceBoardState({}),
  );
  const [boardPersistenceNotice, setBoardPersistenceNotice] =
    useState<BoardPersistenceNotice | null>(null);
  const [workspaceToolPanes, setWorkspaceToolPanes] = useState<WorkspaceToolPane[]>([]);
  const [paneRecoveryStates, setPaneRecoveryStates] = useState<
    Record<string, WorkspacePaneRecoveryInput>
  >({});
  const terminalsRef = useRef<Map<string, TerminalEntry>>(new Map());
  const activeSessionNameRef = useRef<string | null>(null);
  const pendingTerminalFocusSessionNameRef = useRef<string | null>(null);

  const showGitAddFailure = useCallback((message: string) => {
    setGitAddError(message);
    toast.error(GIT_TERMINAL_ADD_ERROR_TITLE, { description: message });
  }, []);
  const workspaceRootRef = useRef<HTMLElement>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);
  const gitSearchInputRef = useRef<HTMLInputElement>(null);
  const canCreateSession = true;
  const isUnifiedSource = source === "unified";
  const keepAliveStatus = useKeepAliveStatus(workspaceId);
  const isComposeSheet = useIsComposeSheet();
  const {
    isKeyboardVisible: visualKeyboardVisible,
    visualViewportHeightPx,
    visualViewportOffsetTopPx,
  } = useVisualViewportKeyboardOffset();
  const isMobileKeyboardVisible = isComposeSheet && visualKeyboardVisible;
  const activeBoard = useMemo(() => findActiveWorkspaceBoard(boardState), [boardState]);
  const boardRenderModels = useMemo<WorkspaceBoardRenderModel[]>(
    () =>
      boardState.boards.map((board) => {
        const boardVisibleSessions = deriveVisibleSessionsFromBoard(sessions, board);
        const boardToolPanes = workspaceToolPanes.filter((pane) => pane.boardKey === board.key);
        return {
          board,
          isActive: board.key === activeBoard?.key,
          visibleSessions: boardVisibleSessions,
          toolPanes: boardToolPanes,
          layout: resolveSessionPaneLayout({
            sessions: [
              ...boardVisibleSessions.map((session) => ({
                sessionName: session.sessionName,
                label: session.label,
              })),
              ...boardToolPanes.map((pane) => ({ sessionName: pane.key, label: pane.label })),
            ],
            persistedJson: persistedLayoutJson,
          }),
        };
      }),
    [activeBoard?.key, boardState.boards, persistedLayoutJson, sessions, workspaceToolPanes],
  );
  const activeBoardRenderModel = useMemo(
    () => boardRenderModels.find((model) => model.isActive) ?? boardRenderModels[0],
    [boardRenderModels],
  );
  const visibleSessions = activeBoardRenderModel?.visibleSessions ?? [];
  const visibleBoardPaneKeys = useMemo(
    () => visibleSessions.map((session) => session.boardPaneKey),
    [visibleSessions],
  );
  const mountedBoardPaneKeys = useMemo(
    () =>
      boardRenderModels.flatMap((model) =>
        model.visibleSessions.map((session) => session.boardPaneKey),
      ),
    [boardRenderModels],
  );
  const paneRecoveryStateMap = useMemo(
    () => new Map(Object.entries(paneRecoveryStates)),
    [paneRecoveryStates],
  );
  const workspaceHealthLoading = useMemo(
    () =>
      !loading &&
      !loadFailed &&
      mountedBoardPaneKeys.length > 0 &&
      mountedBoardPaneKeys.some((key) => !isWorkspacePaneHealthy(paneRecoveryStateMap.get(key))),
    [loadFailed, loading, mountedBoardPaneKeys, paneRecoveryStateMap],
  );
  activeSessionNameRef.current = activeSessionName;

  const layout = activeBoardRenderModel?.layout ?? resolveSessionPaneLayout({ sessions: [] });
  const activeLabel = visibleSessions.find(
    (session) => session.sessionName === activeSessionName,
  )?.label;
  const activeTerminalEntry = useMemo(() => {
    void terminalStateVersion;
    return activeSessionName ? terminalsRef.current.get(activeSessionName) : undefined;
  }, [activeSessionName, terminalStateVersion]);
  const activeBoardGitPaneIdentities = useMemo(
    () =>
      new Set(
        (activeBoard?.panes ?? []).flatMap((pane) =>
          pane.kind === "git" ? [gitPaneIdentity(pane.cloneSessionKey, pane.relativePath)] : [],
        ),
      ),
    [activeBoard],
  );
  const activeBoardSessionNames = useMemo(
    () =>
      new Set(
        (activeBoard?.panes ?? []).flatMap((pane) => (pane.sessionName ? [pane.sessionName] : [])),
      ),
    [activeBoard],
  );
  const favoriteGitRepositories = useMemo(() => {
    const repositoryByIdentity = new Map(
      gitRepositories.map((repository) => [
        gitPaneIdentity(repository.cloneSessionKey, repository.relativePath),
        repository,
      ]),
    );
    const seen = new Set<string>();
    const query = gitSearchQuery.trim().toLowerCase();

    return gitFavorites.flatMap((favorite): GitFavoriteRepositoryOption[] => {
      if (favorite.kind !== "git" || favorite.workspaceId !== workspaceId) return [];
      if (!favorite.relativePath) return [];
      const favoriteIdentity = gitPaneIdentity(favorite.targetKey, favorite.relativePath);
      if (seen.has(favoriteIdentity)) return [];
      const repository = repositoryByIdentity.get(favoriteIdentity);
      if (!repository) return [];
      if (
        query &&
        !repository.label.toLowerCase().includes(query) &&
        !repository.relativePath.toLowerCase().includes(query) &&
        !(favorite.label ?? "").toLowerCase().includes(query)
      ) {
        return [];
      }
      seen.add(favoriteIdentity);
      return [
        {
          ...repository,
          favoriteLabel: favorite.label?.trim() || repository.label,
        },
      ];
    });
  }, [gitFavorites, gitRepositories, gitSearchQuery, workspaceId]);
  const favoriteGitRepositoryIdentities = useMemo(
    () =>
      new Set(
        favoriteGitRepositories.map((repository) =>
          gitPaneIdentity(repository.cloneSessionKey, repository.relativePath),
        ),
      ),
    [favoriteGitRepositories],
  );
  const filteredGitRepositories = useMemo(() => {
    const query = gitSearchQuery.trim().toLowerCase();
    return gitRepositories.filter((repository) => {
      if (
        favoriteGitRepositoryIdentities.has(
          gitPaneIdentity(repository.cloneSessionKey, repository.relativePath),
        )
      )
        return false;
      if (!query) return false;
      return (
        repository.label.toLowerCase().includes(query) ||
        repository.relativePath.toLowerCase().includes(query)
      );
    });
  }, [favoriteGitRepositoryIdentities, gitRepositories, gitSearchQuery]);
  const filteredTerminalSessions = useMemo(() => {
    const query = gitSearchQuery.trim().toLowerCase();
    if (!query) return [];

    return sessions
      .filter(
        (session) =>
          session.label.toLowerCase().includes(query) ||
          session.sessionName.toLowerCase().includes(query),
      )
      .slice(0, 6);
  }, [gitSearchQuery, sessions]);
  const layoutPersistenceMessage = buildLayoutPersistenceMessage(
    layoutPersistenceNotice,
    layout.diagnostics,
  );
  const layoutPersistenceCodes = [
    ...(layoutPersistenceNotice ? [layoutPersistenceNotice.code] : []),
    ...layout.diagnostics.map((diagnostic) => diagnostic.code),
  ].join(" ");
  const boardPersistenceMessage = buildBoardPersistenceMessage(
    boardPersistenceNotice,
    boardState.diagnostics,
  );
  const boardPersistenceCodes = [
    ...(boardPersistenceNotice ? [boardPersistenceNotice.code] : []),
    ...boardState.diagnostics.map((diagnostic) => diagnostic.code),
  ].join(" ");
  const workspaceRecoverySummary = useMemo(
    () =>
      summarizeWorkspacePaneRecovery({
        visibleBoardPaneKeys,
        panes: paneRecoveryStates,
        keepalive: keepAliveStatus.isLoading
          ? null
          : {
              status: keepAliveStatus.status,
              consecutiveFailures: keepAliveStatus.consecutiveFailures,
              lastFailureCategory: keepAliveStatus.lastFailureCategory,
              activeConnectionCount: keepAliveStatus.activeConnectionCount,
            },
      }),
    [keepAliveStatus, paneRecoveryStates, visibleBoardPaneKeys],
  );

  const clearActiveTerminal = useCallback(() => {
    setActiveTerminal(null, null);
  }, [setActiveTerminal]);

  const persistLayoutJson = useCallback(
    (nextLayoutJson: string | null) => {
      const storageKey = storageKeyForWorkspace(workspaceId, source);
      setPersistedLayoutJson(nextLayoutJson);

      if (typeof window === "undefined") return;

      try {
        if (nextLayoutJson === null) {
          window.localStorage.removeItem(storageKey);
        } else {
          window.localStorage.setItem(storageKey, nextLayoutJson);
        }
        setLayoutPersistenceNotice(null);
      } catch {
        setLayoutPersistenceNotice({
          code: nextLayoutJson === null ? "storage-reset-failed" : "storage-write-failed",
          message:
            nextLayoutJson === null
              ? "Layout storage could not be cleared. Safe controls remain available."
              : "Layout changes are active for this view but could not be saved locally.",
        });
      }
    },
    [source, workspaceId],
  );

  const persistSessionOrder = useCallback(
    (orderedSessions: readonly WorkspaceSessionPane[], nextActiveSessionName: string | null) => {
      const panes = orderedSessions.map(
        (session, order): PersistedWorkspaceSessionPane => ({
          sessionName: session.sessionName,
          mode: "tiled",
          order,
          cloneSessionKey: session.cloneSessionKey,
          relativePath: session.relativePath,
          label: session.label,
        }),
      );
      persistLayoutJson(serializeWorkspacePaneLayout(panes, nextActiveSessionName));
    },
    [persistLayoutJson],
  );

  const persistBoardState = useCallback(
    (nextState: WorkspaceBoardState) => {
      setBoardState(nextState);
      if (typeof window === "undefined") return;

      try {
        window.localStorage.setItem(
          workspaceBoardStorageKey(workspaceId, source),
          serializeWorkspaceBoardState(nextState),
        );
        setBoardPersistenceNotice(null);
      } catch {
        setBoardPersistenceNotice({
          code: "storage-write-failed",
          message: "Board changes are active for this view but could not be saved locally.",
        });
      }
    },
    [source, workspaceId],
  );

  const selectSession = useCallback(
    (sessionName: string, options: { focusTerminal?: boolean } = {}) => {
      const lockedSessionName = composeOpen
        ? (composeTargetSessionName ?? activeSessionNameRef.current)
        : null;
      if (lockedSessionName && sessionName !== lockedSessionName) return;

      const { focusTerminal = true } = options;
      const shouldFocusTerminal = focusTerminal && !isComposeSheet;
      pendingTerminalFocusSessionNameRef.current = shouldFocusTerminal ? sessionName : null;
      setActiveSessionName(sessionName);

      const selectedPane = visibleSessions.find((session) => session.sessionName === sessionName);
      if (activeBoard && selectedPane && activeBoard.activePaneKey !== selectedPane.boardPaneKey) {
        persistBoardState(
          selectWorkspaceBoardPane(boardState, activeBoard.key, selectedPane.boardPaneKey),
        );
      }

      const entry = terminalsRef.current.get(sessionName);
      if (entry) {
        setActiveTerminal(entry.term, entry.send);
        if (shouldFocusTerminal) {
          entry.term.focus();
          pendingTerminalFocusSessionNameRef.current = null;
        }
        return;
      }
      clearActiveTerminal();
    },
    [
      activeBoard,
      boardState,
      clearActiveTerminal,
      composeOpen,
      composeTargetSessionName,
      isComposeSheet,
      persistBoardState,
      setActiveTerminal,
      visibleSessions,
    ],
  );
  const commandPaletteTabs = useMemo(
    () =>
      visibleSessions.map((session) => ({ id: session.sessionName, sessionName: session.label })),
    [visibleSessions],
  );
  const handlePaletteSelect = useCallback(
    (sessionName: string) => {
      selectSession(sessionName);
    },
    [selectSession],
  );

  const handleCreateBoard = useCallback(() => {
    const nextWorkspaceNumber = boardState.boards.length + 1;
    persistBoardState(createWorkspaceBoard(boardState, `Workspace ${nextWorkspaceNumber}`));
  }, [boardState, persistBoardState]);

  const handleDeleteBoard = useCallback(
    (boardKey: string) => {
      setWorkspaceToolPanes((current) => current.filter((pane) => pane.boardKey !== boardKey));
      persistBoardState(deleteWorkspaceBoard(boardState, boardKey));
    },
    [boardState, persistBoardState],
  );

  const handleSelectBoard = useCallback(
    (boardKey: string) => persistBoardState(selectWorkspaceBoard(boardState, boardKey)),
    [boardState, persistBoardState],
  );

  const renderBoardBar = () => (
    <WorkspaceBoardBar
      boards={boardState.boards}
      activeBoardKey={boardState.activeBoardKey}
      onCreate={handleCreateBoard}
      onDelete={handleDeleteBoard}
      onSelect={handleSelectBoard}
      className="w-full min-w-0 max-w-full"
    />
  );

  const renderBoardPersistenceStatus = () =>
    boardPersistenceMessage ? (
      <p
        className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
        data-board-codes={boardPersistenceCodes}
        data-testid="board-persistence-status"
      >
        {boardPersistenceMessage}
      </p>
    ) : null;

  const renderWorkspaceRecoveryStatus = () =>
    workspaceRecoverySummary ? (
      <p
        className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
        data-testid="workspace-recovery-status"
        data-workspace-recovery-keepalive-status={keepAliveStatus.status}
        data-workspace-recovery-keepalive-category={keepAliveStatus.lastFailureCategory ?? "none"}
        data-workspace-recovery-active-connection-count={String(
          keepAliveStatus.activeConnectionCount,
        )}
        {...workspaceRecoverySummary.dataAttributes}
      >
        <span>{workspaceRecoverySummary.message}</span>
        <span className="ml-2 text-[10px] tabular-nums" title="Workspace recovery categories">
          {workspaceRecoverySummary.categories.join(" ")}
        </span>
      </p>
    ) : null;

  const updatePaneRecoveryState = useCallback(
    (
      boardPaneKey: string,
      kind: WorkspacePaneRecoveryInput["kind"],
      patch: Partial<WorkspacePaneRecoveryInput>,
    ) => {
      setPaneRecoveryStates((current) => {
        const currentState = current[boardPaneKey];
        const nextState = {
          ...currentState,
          boardPaneKey,
          kind,
          ...patch,
        };

        const hasChanged =
          !currentState ||
          currentState.boardPaneKey !== nextState.boardPaneKey ||
          currentState.kind !== nextState.kind ||
          ("connectionState" in patch && currentState.connectionState !== patch.connectionState) ||
          ("recoveryState" in patch && currentState.recoveryState !== patch.recoveryState) ||
          ("gitRefreshState" in patch && currentState.gitRefreshState !== patch.gitRefreshState);

        if (!hasChanged) return current;
        return {
          ...current,
          [boardPaneKey]: nextState,
        };
      });
    },
    [],
  );

  const updatePaneGitRefreshState = useCallback(
    (boardPaneKey: string | undefined, status: WorkspaceGitPaneRefreshInput) => {
      if (!boardPaneKey) return;
      updatePaneRecoveryState(boardPaneKey, "git", { gitRefreshState: status });
    },
    [updatePaneRecoveryState],
  );

  const clearPaneRecoveryState = useCallback((boardPaneKey: string) => {
    setPaneRecoveryStates((current) => {
      if (!(boardPaneKey in current)) return current;
      const next = { ...current };
      delete next[boardPaneKey];
      return next;
    });
  }, []);

  const handlePaneConnectionStateChange = useCallback(
    (
      boardPaneKey: string,
      kind: WorkspacePaneRecoveryInput["kind"],
      connectionState: ConnectionState,
    ) => {
      updatePaneRecoveryState(boardPaneKey, kind, { connectionState });
    },
    [updatePaneRecoveryState],
  );

  const handlePaneRecoveryStateChange = useCallback(
    (
      boardPaneKey: string,
      kind: WorkspacePaneRecoveryInput["kind"],
      recoveryState: TerminalRecoveryState,
    ) => {
      updatePaneRecoveryState(boardPaneKey, kind, { recoveryState });
    },
    [updatePaneRecoveryState],
  );

  const handleTerminalReady = useCallback(
    (sessionName: string, term: Terminal, send: (data: string) => void) => {
      terminalsRef.current.set(sessionName, { term, send });
      if (activeSessionNameRef.current === sessionName) {
        setActiveTerminal(term, send);
        if (!isComposeSheet && pendingTerminalFocusSessionNameRef.current === sessionName) {
          term.focus();
          pendingTerminalFocusSessionNameRef.current = null;
        }
      }
      setTerminalStateVersion((version) => version + 1);
    },
    [isComposeSheet, setActiveTerminal],
  );

  const handleTerminalDestroy = useCallback(
    (sessionName: string) => {
      terminalsRef.current.delete(sessionName);
      if (activeSessionNameRef.current === sessionName) {
        clearActiveTerminal();
      }
      setTerminalStateVersion((version) => version + 1);
    },
    [clearActiveTerminal],
  );

  const openComposeWithDraft = useCallback(
    (request: TerminalComposeRequest, sessionName = activeSessionNameRef.current) => {
      setComposeTargetSessionName(sessionName);
      setComposeTargetLabel(request.targetLabel);
      setComposeDraft((current) => {
        if (!request.append || !current) return request.draft;
        return `${current.replace(/\s*$/, "")}\n${request.draft}`;
      });
      setComposeOpen(true);
    },
    [],
  );

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeDraft("");
    setComposeTargetSessionName(null);
    setComposeTargetLabel(undefined);
  }, []);

  const sendComposeDraft = useCallback(
    (draft: string) => {
      const targetName = composeTargetSessionName ?? activeSessionNameRef.current;
      const entry = targetName ? terminalsRef.current.get(targetName) : null;
      if (!entry) return;
      entry.send(draft);
      entry.send("\r");
    },
    [composeTargetSessionName],
  );

  useEffect(() => {
    const handleComposeToggle = () => {
      setComposeOpen((open) => {
        if (open) {
          setComposeTargetSessionName(null);
          setComposeTargetLabel(undefined);
          return false;
        }

        const targetSessionName = activeSessionNameRef.current;
        setComposeTargetSessionName(targetSessionName);
        setComposeTargetLabel(activeLabel ?? targetSessionName ?? undefined);
        return true;
      });
    };
    window.addEventListener(TERMINAL_COMPOSE_TOGGLE_EVENT, handleComposeToggle);
    return () => {
      window.removeEventListener(TERMINAL_COMPOSE_TOGGLE_EVENT, handleComposeToggle);
    };
  }, [activeLabel]);

  const handleSelectionModeChange = useCallback((enabled: boolean) => {
    setSelectionModeEnabled(enabled);
    setClipboardActionStatus(null);
  }, []);

  const handleClipboardActionStatus = useCallback((status: ClipboardActionStatus) => {
    setClipboardActionStatus(status);
    toastPasteError(status);
  }, []);

  const handleMobileCopy = useCallback(() => {
    const term = activeTerminalEntry?.term;
    if (!term) return;
    copyTerminalSelection(term, { onStatus: handleClipboardActionStatus });
  }, [activeTerminalEntry, handleClipboardActionStatus]);

  const handleMobilePaste = useCallback(() => {
    const entry = activeTerminalEntry;
    if (!entry) return;
    pasteClipboardApiToTerminal(entry.term, entry.send, {
      onStatus: handleClipboardActionStatus,
      onCompose: openComposeWithDraft,
      targetLabel: activeLabel,
      workspaceId,
    });
  }, [
    activeLabel,
    activeTerminalEntry,
    handleClipboardActionStatus,
    openComposeWithDraft,
    workspaceId,
  ]);

  useEffect(() => {
    if (!activeTerminalEntry) {
      setHasTerminalSelection(false);
      return;
    }

    const updateSelectionState = () =>
      setHasTerminalSelection(terminalHasSelection(activeTerminalEntry.term));
    updateSelectionState();

    if (typeof activeTerminalEntry.term.onSelectionChange !== "function") return;

    const disposable = activeTerminalEntry.term.onSelectionChange(updateSelectionState);
    return () => disposable.dispose();
  }, [activeTerminalEntry]);

  const focusRelativeSession = useCallback(
    (direction: -1 | 1) => {
      if (visibleSessions.length === 0) return;
      const currentIndex = Math.max(
        0,
        visibleSessions.findIndex(
          (session) => session.sessionName === activeSessionNameRef.current,
        ),
      );
      const nextIndex =
        (currentIndex + direction + visibleSessions.length) % visibleSessions.length;
      selectSession(visibleSessions[nextIndex].sessionName);
    },
    [selectSession, visibleSessions],
  );

  const mobileWindowNavigation = useMemo(() => {
    const sessionsForControls = visibleSessions.map((session) => ({
      id: session.sessionName,
      name: session.label,
    }));
    const currentIndex = Math.max(
      0,
      visibleSessions.findIndex((session) => session.sessionName === activeSessionName),
    );
    const current = sessionsForControls[currentIndex] ?? null;
    const previous =
      sessionsForControls.length > 1
        ? sessionsForControls[
            (currentIndex - 1 + sessionsForControls.length) % sessionsForControls.length
          ]
        : null;
    const next =
      sessionsForControls.length > 1
        ? sessionsForControls[(currentIndex + 1) % sessionsForControls.length]
        : null;

    return {
      sessions: sessionsForControls,
      current,
      previous,
      next,
      canGoPrevious: Boolean(previous),
      canGoNext: Boolean(next),
      loading: false,
      error: null,
      reload: () => setReloadKey((value) => value + 1),
      select: (id: string) => {
        const target = visibleSessions.find(
          (session) => session.sessionName === id || session.label === id,
        );
        if (!target) return false;
        selectSession(target.sessionName, { focusTerminal: false });
        return true;
      },
      onOpenSwitcher: () => setPaletteOpen(true),
    };
  }, [activeSessionName, selectSession, visibleSessions]);

  const switchRelativeWorkspaceBoard = useCallback(
    (direction: -1 | 1) => {
      const orderedBoards = orderedWorkspaceBoards(boardState.boards);
      if (orderedBoards.length <= 1) return;

      const activeBoardKey = boardState.activeBoardKey ?? activeBoard?.key;
      const currentIndex = Math.max(
        0,
        orderedBoards.findIndex((board) => board.key === activeBoardKey),
      );
      const nextBoard =
        orderedBoards[(currentIndex + direction + orderedBoards.length) % orderedBoards.length];
      if (!nextBoard || nextBoard.key === activeBoardKey) return;

      persistBoardState(selectWorkspaceBoard(boardState, nextBoard.key));
    },
    [activeBoard?.key, boardState, persistBoardState],
  );

  const switchToWorkspaceBoardIndex = useCallback(
    (workspaceIndex: number) => {
      const targetBoard = orderedWorkspaceBoards(boardState.boards)[workspaceIndex - 1];
      if (!targetBoard) {
        toast.info(`Workspace ${workspaceIndex} does not exist.`);
        return;
      }

      if (targetBoard.key === (boardState.activeBoardKey ?? activeBoard?.key)) return;
      persistBoardState(selectWorkspaceBoard(boardState, targetBoard.key));
    },
    [activeBoard?.key, boardState, persistBoardState],
  );

  const openGitSearchModal = useCallback(() => {
    if (!isUnifiedSource) return;
    setGitSearchOpen(true);
    setGitAddError(null);
  }, [isUnifiedSource]);

  const closeGitSearchModal = useCallback(() => {
    setGitSearchOpen(false);
    setGitSearchQuery("");
    setGitAddError(null);
  }, []);

  const handleWorkspaceShortcutKeyDown = useCallback(
    (event: WorkspaceShortcutEvent) => {
      if (event.defaultPrevented) return false;
      if (!(event.ctrlKey || event.metaKey)) return false;
      if (event.shiftKey) return false;

      const isTextEntryTarget = isTextEntryEventTarget(event.target);
      const isTerminalHelperTarget = isTerminalHelperTextAreaTarget(event.target);
      const workspaceIndex = workspaceIndexFromShortcutEvent(event);
      if (!event.altKey && workspaceIndex && (!isTextEntryTarget || isTerminalHelperTarget)) {
        event.preventDefault();
        switchToWorkspaceBoardIndex(workspaceIndex);
        return true;
      }

      if (isTextEntryTarget && !isTerminalHelperTarget) return false;

      const arrowDirection = workspaceArrowDirectionFromShortcutEvent(event);
      if (arrowDirection) {
        event.preventDefault();
        if (event.altKey) {
          switchRelativeWorkspaceBoard(arrowDirection);
        } else {
          focusRelativeSession(arrowDirection);
        }
        return true;
      }

      return false;
    },
    [focusRelativeSession, switchRelativeWorkspaceBoard, switchToWorkspaceBoardIndex],
  );

  const handleWorkspaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      handleWorkspaceShortcutKeyDown(event.nativeEvent);
    },
    [handleWorkspaceShortcutKeyDown],
  );

  useEffect(() => {
    const handleCapturedWorkspaceKeyDown = (event: KeyboardEvent) => {
      const target = eventTargetElement(event.target);
      if (
        target &&
        workspaceRootRef.current &&
        !workspaceRootRef.current.contains(target) &&
        !isTerminalHelperTextAreaTarget(event.target)
      ) {
        return;
      }

      if (!handleWorkspaceShortcutKeyDown(event)) return;
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener("keydown", handleCapturedWorkspaceKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleCapturedWorkspaceKeyDown, { capture: true });
    };
  }, [handleWorkspaceShortcutKeyDown]);

  useEffect(() => {
    register({
      id: `multi-session:${workspaceId}:previous-pane`,
      keys: ["ctrl+arrowleft", "cmd+arrowleft", "ctrl+arrowup", "cmd+arrowup"],
      action: () => {
        focusRelativeSession(-1);
        return false;
      },
      description: "Focus previous terminal pane",
      category: "terminal",
      enabledInBrowser: true,
    });
    register({
      id: `multi-session:${workspaceId}:next-pane`,
      keys: ["ctrl+arrowright", "cmd+arrowright", "ctrl+arrowdown", "cmd+arrowdown"],
      action: () => {
        focusRelativeSession(1);
        return false;
      },
      description: "Focus next terminal pane",
      category: "terminal",
      enabledInBrowser: true,
    });
    register({
      id: `multi-session:${workspaceId}:previous-board`,
      keys: ["cmd+alt+arrowleft", "ctrl+alt+arrowleft"],
      action: () => {
        switchRelativeWorkspaceBoard(-1);
        return false;
      },
      description: "Switch to previous workspace board",
      category: "terminal",
      enabledInBrowser: true,
      global: true,
    });
    register({
      id: `multi-session:${workspaceId}:next-board`,
      keys: ["cmd+alt+arrowright", "ctrl+alt+arrowright"],
      action: () => {
        switchRelativeWorkspaceBoard(1);
        return false;
      },
      description: "Switch to next workspace board",
      category: "terminal",
      enabledInBrowser: true,
      global: true,
    });
    for (const workspaceIndex of WORKSPACE_BOARD_INDEXES) {
      register({
        id: `multi-session:${workspaceId}:board-${workspaceIndex}`,
        keys: [`cmd+${workspaceIndex}`, `ctrl+${workspaceIndex}`],
        action: () => {
          switchToWorkspaceBoardIndex(workspaceIndex);
          return false;
        },
        description: `Switch to workspace ${workspaceIndex}`,
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    }
    return () => {
      unregister(`multi-session:${workspaceId}:previous-pane`);
      unregister(`multi-session:${workspaceId}:next-pane`);
      unregister(`multi-session:${workspaceId}:previous-board`);
      unregister(`multi-session:${workspaceId}:next-board`);
      for (const workspaceIndex of WORKSPACE_BOARD_INDEXES) {
        unregister(`multi-session:${workspaceId}:board-${workspaceIndex}`);
      }
    };
  }, [
    focusRelativeSession,
    register,
    switchRelativeWorkspaceBoard,
    switchToWorkspaceBoardIndex,
    unregister,
    workspaceId,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual retry trigger for session loading
  useEffect(() => {
    const storageKey = storageKeyForWorkspace(workspaceId, source);
    const boardStorageKey = workspaceBoardStorageKey(workspaceId, source);
    const storedLayout = readWorkspaceLayoutStorage(storageKey);
    const storedBoard = readWorkspaceBoardStorage(boardStorageKey);
    const restoredBoardState = resolveWorkspaceBoardState({
      persistedBoardJson: storedBoard.raw,
      legacyPaneLayoutJson: storedLayout.raw,
      fallbackPanes: [],
    });
    const storedActiveSessionName = parsePersistedActiveSessionName(storedLayout.raw);
    let cancelled = false;

    setLoading(true);
    setLoadFailed(false);
    setCreateFailed(false);
    setSessions([]);
    setActiveSessionName(null);
    setGitRepositories([]);
    setGitFavorites([]);
    setGitFavoritesLoading(false);
    setGitFavoritesFailed(false);
    setGitSearchOpen(false);
    setGitSearchQuery("");
    setGitAddError(null);
    setGitRestoreFailed(false);
    setTerminalCloseFailed(false);
    setPaneRecoveryStates({});
    setWorkspaceToolPanes([]);
    setPersistedLayoutJson(storedLayout.raw);
    setLayoutPersistenceNotice(storedLayout.notice);
    setBoardState(restoredBoardState);
    setBoardPersistenceNotice(storedBoard.notice);
    terminalsRef.current.clear();
    pendingTerminalFocusSessionNameRef.current = null;
    clearActiveTerminal();

    async function loadSessions() {
      try {
        const hasValidBoardState = hasValidPersistedBoardState(storedBoard.raw);
        const parsed =
          source === "unified"
            ? await loadUnifiedWorkspaceSessions(
                workspaceId,
                agentId,
                hasValidBoardState ? storedBoard.raw : storedLayout.raw,
              )
            : await loadWorkspaceSessions(workspaceId);
        if (cancelled) return;

        setGitRepositories(parsed.repositories ?? []);
        setGitRestoreFailed(parsed.gitRestoreFailed === true);

        if (parsed.status === "success") {
          const nextBoardState = reconcileGitPaneSessionNames(
            resolveWorkspaceBoardState({
              persistedBoardJson: storedBoard.raw,
              legacyPaneLayoutJson: storedLayout.raw,
              fallbackPanes: hasValidBoardState ? [] : buildFallbackBoardPanes(parsed.sessions),
            }),
            parsed.sessions,
          );
          const nextActiveBoard = findActiveWorkspaceBoard(nextBoardState);
          const nextVisibleSessions = deriveVisibleSessionsFromBoard(
            parsed.sessions,
            nextActiveBoard,
          );
          setBoardState(nextBoardState);
          setSessions(parsed.sessions);
          setActiveSessionName(
            activeSessionNameForVisibleSessions(
              nextVisibleSessions,
              nextActiveBoard,
              storedActiveSessionName,
            ),
          );
          return;
        }

        if (parsed.status === "empty") {
          const nextBoardState = resolveWorkspaceBoardState({
            persistedBoardJson: storedBoard.raw,
            legacyPaneLayoutJson: storedLayout.raw,
            fallbackPanes: [],
          });
          setBoardState(nextBoardState);
          setSessions([]);
          setActiveSessionName(null);
          return;
        }

        setLoadFailed(true);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSessions();

    return () => {
      cancelled = true;
      terminalsRef.current.clear();
      pendingTerminalFocusSessionNameRef.current = null;
      clearActiveTerminal();
    };
  }, [agentId, clearActiveTerminal, reloadKey, source, workspaceId]);

  useEffect(() => {
    if (!gitSearchOpen) return;
    window.requestAnimationFrame(() => gitSearchInputRef.current?.focus());
  }, [gitSearchOpen]);

  useEffect(() => {
    const mountedKeys = new Set(mountedBoardPaneKeys);
    setPaneRecoveryStates((current) => {
      const nextEntries = Object.entries(current).filter(([key]) => mountedKeys.has(key));
      if (nextEntries.length === Object.keys(current).length) return current;
      return Object.fromEntries(nextEntries);
    });
  }, [mountedBoardPaneKeys]);

  useEffect(() => {
    const nextActiveSessionName = activeSessionNameForVisibleSessions(
      visibleSessions,
      activeBoard,
      activeSessionName,
    );
    if (nextActiveSessionName === activeSessionName) return;
    if (nextActiveSessionName) {
      selectSession(nextActiveSessionName, { focusTerminal: false });
      return;
    }
    setActiveSessionName(null);
    clearActiveTerminal();
  }, [activeBoard, activeSessionName, clearActiveTerminal, selectSession, visibleSessions]);

  useEffect(() => {
    if (!isUnifiedSource || (!gitSearchOpen && !paletteOpen)) return;

    let cancelled = false;
    setGitFavoritesLoading(true);
    setGitFavoritesFailed(false);

    async function loadFavorites() {
      try {
        const favorites = unwrapActionData(
          await listNavigationFavoritesAction({ workspaceId, kind: "git" }),
        );
        if (cancelled) return;
        setGitFavorites(Array.isArray(favorites) ? favorites.filter(isNavigationFavoriteDto) : []);
      } catch {
        if (!cancelled) {
          setGitFavorites([]);
          setGitFavoritesFailed(true);
        }
      } finally {
        if (!cancelled) setGitFavoritesLoading(false);
      }
    }

    void loadFavorites();

    return () => {
      cancelled = true;
    };
  }, [gitSearchOpen, isUnifiedSource, paletteOpen, workspaceId]);

  const handleCreateSession = useCallback(
    async (sessionName?: string): Promise<boolean> => {
      if (!canCreateSession) return false;
      const trimmedSessionName = sessionName?.trim();
      const safeSessionName =
        trimmedSessionName && SAFE_IDENTIFIER_RE.test(trimmedSessionName)
          ? trimmedSessionName
          : undefined;
      setCreating(true);
      setCreateFailed(false);

      try {
        const result = await createSessionAction(
          safeSessionName ? { workspaceId, sessionName: safeSessionName } : { workspaceId },
        );
        const parsed = parseCreateResult(result);
        if (parsed.status === "failure") {
          setCreateFailed(true);
          return false;
        }

        setSessions((current) => {
          const next = uniqueSessions([...current, parsed.session]);
          persistSessionOrder(next, parsed.session.sessionName);
          return next;
        });
        persistBoardState(
          addTerminalPaneToActiveWorkspaceBoard(boardState, {
            sessionName: parsed.session.sessionName,
            label: parsed.session.label,
          }),
        );
        selectSession(parsed.session.sessionName);
        window.dispatchEvent(new CustomEvent("hive:sidebar-refresh", { detail: { workspaceId } }));
        return true;
      } catch {
        setCreateFailed(true);
        return false;
      } finally {
        setCreating(false);
      }
    },
    [boardState, persistBoardState, persistSessionOrder, selectSession, workspaceId],
  );

  const refreshGitPaneCloneTerminalIdentity = useCallback(
    async (
      expectedSessionName: string,
      cloneSessionKey: string,
      relativePath: string,
      boardPaneKey?: string,
    ): Promise<{ sessionName: string; clonePath: string; cloneProof: string }> => {
      updatePaneGitRefreshState(boardPaneKey, { status: "refreshing", failureCategory: null });
      let failureCategory: WorkspaceGitPaneRefreshInput["failureCategory"] = "callback-error";

      try {
        const identity = unwrapActionData(
          await resolveGitCloneTerminalAction({
            agentId,
            workspaceId,
            cloneSessionKey,
            relativePath,
          }),
        );

        if (!isGitCloneTerminalIdentity(identity)) {
          failureCategory = "malformed-identity";
          updatePaneGitRefreshState(boardPaneKey, { status: "failed", failureCategory });
          throw new Error("Git clone terminal refresh failed");
        }

        if (identity.sessionName !== expectedSessionName) {
          failureCategory = "session-name-mismatch";
          updatePaneGitRefreshState(boardPaneKey, { status: "failed", failureCategory });
          throw new Error("Git clone terminal refresh failed");
        }

        setSessions((current) =>
          current.map((session) =>
            session.sessionName === expectedSessionName
              ? {
                  ...session,
                  clonePath: identity.clonePath,
                  cloneProof: identity.cloneProof,
                  cloneSessionKey: session.cloneSessionKey ?? cloneSessionKey,
                  relativePath: session.relativePath ?? relativePath,
                }
              : session,
          ),
        );
        updatePaneGitRefreshState(boardPaneKey, { status: "succeeded", failureCategory: null });

        return {
          sessionName: identity.sessionName,
          clonePath: identity.clonePath,
          cloneProof: identity.cloneProof,
        };
      } catch (error) {
        updatePaneGitRefreshState(boardPaneKey, { status: "failed", failureCategory });
        throw error;
      }
    },
    [agentId, updatePaneGitRefreshState, workspaceId],
  );

  const openTerminalSessionPage = useCallback(
    (session: WorkspaceSessionPane) => {
      const params = new URLSearchParams({ session: session.sessionName });
      if (session.clonePath && session.cloneProof) {
        params.set("clonePath", session.clonePath);
        params.set("cloneProof", session.cloneProof);
      }
      if (session.cloneSessionKey && session.relativePath) {
        params.set("cloneSessionKey", session.cloneSessionKey);
        params.set("relativePath", session.relativePath);
      }
      router.push(`/workspaces/${encodeURIComponent(workspaceId)}/terminal?${params.toString()}`);
    },
    [router, workspaceId],
  );

  const openGitRepositoryTerminalPage = useCallback(
    async (repository: GitRepositoryOption) => {
      setAddingCloneKey(gitPaneIdentity(repository.cloneSessionKey, repository.relativePath));
      setGitAddError(null);

      try {
        const result = await resolveGitCloneTerminalAction({
          agentId,
          workspaceId,
          cloneSessionKey: repository.cloneSessionKey,
          relativePath: repository.relativePath,
        });
        const identity = unwrapActionData(result);
        if (!isGitCloneTerminalIdentity(identity)) {
          showGitAddFailure(actionFailureMessage(result, GIT_TERMINAL_ADD_FALLBACK_MESSAGE));
          return;
        }

        const params = new URLSearchParams({
          session: identity.sessionName,
          clonePath: identity.clonePath,
          cloneProof: identity.cloneProof,
          cloneSessionKey: repository.cloneSessionKey,
          relativePath: repository.relativePath,
        });
        router.push(`/workspaces/${encodeURIComponent(workspaceId)}/terminal?${params.toString()}`);
      } catch {
        showGitAddFailure(GIT_TERMINAL_ADD_FALLBACK_MESSAGE);
      } finally {
        setAddingCloneKey(null);
      }
    },
    [agentId, router, showGitAddFailure, workspaceId],
  );

  useEffect(() => {
    register({
      id: `multi-session:${workspaceId}:create-terminal-session`,
      keys: [...CREATE_TERMINAL_SESSION_SHORTCUT_KEYS],
      action: () => {
        void handleCreateSession();
        return false;
      },
      description: "Create new terminal session",
      category: "terminal",
      enabledInBrowser: true,
      global: true,
    });

    return () => unregister(`multi-session:${workspaceId}:create-terminal-session`);
  }, [handleCreateSession, register, unregister, workspaceId]);

  const handleAddGitRepository = useCallback(
    async (repository: GitRepositoryOption) => {
      if (!isUnifiedSource) return;
      const repositoryIdentity = gitPaneIdentity(
        repository.cloneSessionKey,
        repository.relativePath,
      );
      const existingSession = sessions.find(
        (session) =>
          session.cloneSessionKey &&
          session.relativePath &&
          gitPaneIdentity(session.cloneSessionKey, session.relativePath) === repositoryIdentity,
      );
      setGitAddError(null);

      if (existingSession) {
        persistBoardState(
          addGitPaneToActiveWorkspaceBoard(boardState, {
            cloneSessionKey: repository.cloneSessionKey,
            relativePath: repository.relativePath,
            sessionName: existingSession.sessionName,
            label: repository.label,
          }),
        );
        selectSession(existingSession.sessionName);
        setGitSearchOpen(false);
        setGitSearchQuery("");
        return;
      }

      setAddingCloneKey(repositoryIdentity);

      try {
        const result = await resolveGitCloneTerminalAction({
          agentId,
          workspaceId,
          cloneSessionKey: repository.cloneSessionKey,
          relativePath: repository.relativePath,
        });
        const identity = unwrapActionData(result);
        if (!isGitCloneTerminalIdentity(identity)) {
          showGitAddFailure(actionFailureMessage(result, GIT_TERMINAL_ADD_FALLBACK_MESSAGE));
          return;
        }

        const session: WorkspaceSessionPane = {
          sessionName: identity.sessionName,
          label: repository.label,
          clonePath: identity.clonePath,
          cloneProof: identity.cloneProof,
          cloneSessionKey: repository.cloneSessionKey,
          relativePath: repository.relativePath,
        };

        setSessions((current) => {
          const next = uniqueSessions([...current, session]);
          persistSessionOrder(next, session.sessionName);
          return next;
        });
        persistBoardState(
          addGitPaneToActiveWorkspaceBoard(boardState, {
            cloneSessionKey: repository.cloneSessionKey,
            relativePath: repository.relativePath,
            sessionName: session.sessionName,
            label: repository.label,
          }),
        );
        selectSession(session.sessionName);
        setGitSearchOpen(false);
        setGitSearchQuery("");
      } catch {
        showGitAddFailure(GIT_TERMINAL_ADD_FALLBACK_MESSAGE);
      } finally {
        setAddingCloneKey(null);
      }
    },
    [
      agentId,
      boardState,
      isUnifiedSource,
      persistBoardState,
      persistSessionOrder,
      selectSession,
      showGitAddFailure,
      sessions,
      workspaceId,
    ],
  );

  const handleAddExistingTerminalToBoard = useCallback(
    (session: WorkspaceSessionPane) => {
      const nextState =
        session.cloneSessionKey && session.relativePath
          ? addGitPaneToActiveWorkspaceBoard(boardState, {
              cloneSessionKey: session.cloneSessionKey,
              relativePath: session.relativePath,
              sessionName: session.sessionName,
              label: session.label,
            })
          : addTerminalPaneToActiveWorkspaceBoard(boardState, {
              sessionName: session.sessionName,
              label: session.label,
            });
      persistBoardState(nextState);
      selectSession(session.sessionName);
    },
    [boardState, persistBoardState, selectSession],
  );

  const openWorkspaceToolPane = useCallback(
    (
      boardKey: string,
      session: WorkspaceSessionPane,
      tool: WorkspaceTool,
      urls: WorkspaceSessionToolUrls,
    ) => {
      const key = `workspace-tool:${boardKey}:${session.sessionName}:${tool}`;
      const label = `${tool === "code" ? "VS Code" : "Files"} · ${session.label}`;
      setWorkspaceToolPanes((current) => [
        ...current.filter((pane) => pane.key !== key),
        {
          key,
          boardKey,
          sourceSessionName: session.sessionName,
          tool,
          url: tool === "code" ? urls.codeUrl : urls.filesUrl,
          label,
          folderPath: urls.folderPath,
        },
      ]);
    },
    [],
  );

  const openWorkspaceToolForSession = useCallback(
    async (session: WorkspaceSessionPane, tool: WorkspaceTool) => {
      if (!activeBoard) return;
      try {
        const result = await getWorkspaceSessionToolsAction({
          workspaceId,
          sessionName: session.sessionName,
          fallbackPath: session.clonePath,
          tool,
        });
        const urls = unwrapActionData(result);
        if (!isWorkspaceSessionToolUrls(urls)) {
          toast.error("Could not open workspace tools for this session.");
          return;
        }
        openWorkspaceToolPane(activeBoard.key, session, tool, urls);
      } catch {
        toast.error("Could not open workspace tools for this session.");
      }
    },
    [activeBoard, openWorkspaceToolPane, workspaceId],
  );

  const openWorkspaceToolForGitRepository = useCallback(
    async (repository: GitRepositoryOption, tool: WorkspaceTool) => {
      if (!activeBoard) return;
      const repositoryIdentity = gitPaneIdentity(
        repository.cloneSessionKey,
        repository.relativePath,
      );
      setAddingCloneKey(repositoryIdentity);
      setGitAddError(null);
      try {
        const existingSession = sessions.find(
          (session) =>
            session.cloneSessionKey === repository.cloneSessionKey &&
            session.relativePath === repository.relativePath,
        );
        let session = existingSession;
        if (!session) {
          const result = await resolveGitCloneTerminalAction({
            agentId,
            workspaceId,
            cloneSessionKey: repository.cloneSessionKey,
            relativePath: repository.relativePath,
          });
          const identity = unwrapActionData(result);
          if (!isGitCloneTerminalIdentity(identity)) {
            showGitAddFailure(actionFailureMessage(result, GIT_TERMINAL_ADD_FALLBACK_MESSAGE));
            return;
          }
          session = {
            sessionName: identity.sessionName,
            label: repository.label,
            clonePath: identity.clonePath,
            cloneProof: identity.cloneProof,
            cloneSessionKey: repository.cloneSessionKey,
            relativePath: repository.relativePath,
          };
          const resolvedSession = session;
          setSessions((current) => uniqueSessions([...current, resolvedSession]));
        }
        await openWorkspaceToolForSession(session, tool);
      } catch {
        showGitAddFailure(GIT_TERMINAL_ADD_FALLBACK_MESSAGE);
      } finally {
        setAddingCloneKey(null);
      }
    },
    [activeBoard, agentId, openWorkspaceToolForSession, sessions, showGitAddFailure, workspaceId],
  );

  const paletteQuery = gitSearchQuery.trim();
  const paletteQueryLower = paletteQuery.toLowerCase();
  const paletteMatchesExisting =
    paletteQueryLower.length > 0 &&
    (sessions.some(
      (session) =>
        session.label.toLowerCase().includes(paletteQueryLower) ||
        session.sessionName.toLowerCase().includes(paletteQueryLower),
    ) ||
      gitRepositories.some(
        (repository) =>
          repository.label.toLowerCase().includes(paletteQueryLower) ||
          repository.relativePath.toLowerCase().includes(paletteQueryLower),
      ));

  const workspacePaletteActions = useMemo<CommandPaletteAction[]>(() => {
    if (!isUnifiedSource) return [];

    const actions: CommandPaletteAction[] = [];
    const typedSessionName =
      paletteQuery.length > 0 && SAFE_IDENTIFIER_RE.test(paletteQuery) ? paletteQuery : undefined;
    const typedCreateAction: CommandPaletteAction = {
      id: "workspace:new-terminal-from-query",
      label: typedSessionName
        ? `New terminal session named ${typedSessionName}`
        : "New terminal session in workspace",
      description: typedSessionName
        ? "Create and focus this session in the workspace"
        : "Create and focus a plain terminal session in the workspace",
      group: "Actions",
      value: `${paletteQuery} new terminal session workspace`,
      shortcut: formatShortcut(CREATE_TERMINAL_SESSION_SHORTCUT_KEYS),
      icon: "plus",
      disabled: creating,
      onSelect: () => void handleCreateSession(typedSessionName),
    };

    if (!paletteQuery || !paletteMatchesExisting) {
      actions.push(typedCreateAction);
    }

    for (const session of sessions.slice(0, 16)) {
      const alreadyInActiveBoard = activeBoardSessionNames.has(session.sessionName);
      actions.push({
        id: `workspace:session:${session.sessionName}`,
        label: session.label,
        description: session.cloneSessionKey ? "Git terminal session" : "Terminal session",
        group: "Terminal sessions",
        value: `${session.label} ${session.sessionName} add open vscode filebrowser workspace terminal session`,
        icon: "terminal",
        onSelect: () => handleAddExistingTerminalToBoard(session),
        options: [
          {
            id: "add",
            label: "Add",
            disabled: alreadyInActiveBoard,
            onSelect: () => handleAddExistingTerminalToBoard(session),
          },
          {
            id: "open",
            label: "Open",
            onSelect: () => {
              openTerminalSessionPage(session);
            },
          },
          {
            id: "vscode",
            label: "VS Code",
            onSelect: () => void openWorkspaceToolForSession(session, "code"),
          },
          {
            id: "filebrowser",
            label: "Files",
            onSelect: () => void openWorkspaceToolForSession(session, "files"),
          },
        ],
      });
    }

    const repositories = [...favoriteGitRepositories, ...filteredGitRepositories].slice(0, 10);
    for (const repository of repositories) {
      const repositoryIdentity = gitPaneIdentity(
        repository.cloneSessionKey,
        repository.relativePath,
      );
      const repositoryPending = addingCloneKey === repositoryIdentity;
      const alreadyInActiveBoard = activeBoardGitPaneIdentities.has(repositoryIdentity);
      actions.push({
        id: `workspace:git:${gitRepositoryActionIdentity(repository)}`,
        label: repository.label,
        description: "Git repository",
        group: "Git repositories",
        value: `${repository.label} ${repository.relativePath} add open vscode filebrowser git repository workspace`,
        icon: "search",
        disabled: repositoryPending,
        onSelect: () => void handleAddGitRepository(repository),
        options: [
          {
            id: "add",
            label: "Add",
            disabled: alreadyInActiveBoard,
            onSelect: () => void handleAddGitRepository(repository),
          },
          {
            id: "open",
            label: "Open",
            onSelect: () => void openGitRepositoryTerminalPage(repository),
          },
          {
            id: "vscode",
            label: "VS Code",
            onSelect: () => void openWorkspaceToolForGitRepository(repository, "code"),
          },
          {
            id: "filebrowser",
            label: "Files",
            onSelect: () => void openWorkspaceToolForGitRepository(repository, "files"),
          },
        ],
      });
    }

    return actions;
  }, [
    activeBoardGitPaneIdentities,
    activeBoardSessionNames,
    addingCloneKey,
    creating,
    favoriteGitRepositories,
    filteredGitRepositories,
    handleAddExistingTerminalToBoard,
    handleAddGitRepository,
    handleCreateSession,
    isUnifiedSource,
    openGitRepositoryTerminalPage,
    openTerminalSessionPage,
    openWorkspaceToolForGitRepository,
    openWorkspaceToolForSession,
    paletteMatchesExisting,
    paletteQuery,
    sessions,
  ]);

  useEffect(
    () =>
      registerGlobalCommandPaletteSource({
        id: `multi-session:${workspaceId}`,
        tabs: isUnifiedSource ? [] : commandPaletteTabs,
        onSelectTab: handlePaletteSelect,
        onCreateSession: isUnifiedSource
          ? undefined
          : () => {
              void handleCreateSession();
            },
        actions: workspacePaletteActions,
        searchValue: isUnifiedSource ? gitSearchQuery : undefined,
        onSearchValueChange: isUnifiedSource ? setGitSearchQuery : undefined,
        searchPlaceholder: isUnifiedSource
          ? "Search terminal sessions, Git repositories, or type a new session name…"
          : "Search workspace sessions…",
        emptyText: isUnifiedSource ? "No command matches." : "No workspace sessions found.",
        groupHeading: "Workspace sessions",
      }),
    [
      commandPaletteTabs,
      gitSearchQuery,
      handleCreateSession,
      handlePaletteSelect,
      isUnifiedSource,
      workspaceId,
      workspacePaletteActions,
    ],
  );

  const handleRemovePane = useCallback(
    async ({ boardKey, boardPaneKey, sessionName }: RemoveWorkspacePaneTarget) => {
      const board = boardKey
        ? boardState.boards.find((candidate) => candidate.key === boardKey)
        : undefined;
      if (!board || !boardPaneKey || !board.panes.some((pane) => pane.key === boardPaneKey)) {
        return;
      }

      setTerminalCloseFailed(false);

      if (!isUnifiedSource) {
        try {
          await killSessionAction({ workspaceId, sessionName });
        } catch {
          setTerminalCloseFailed(true);
          return;
        }
      }

      const nextSessions = isUnifiedSource
        ? sessions
        : sessions.filter((session) => session.sessionName !== sessionName);
      const nextBoardState = removeWorkspaceBoardPaneIdentity(boardState, board.key, boardPaneKey);
      const nextActiveBoard = findActiveWorkspaceBoard(nextBoardState);
      const nextVisibleSessions = deriveVisibleSessionsFromBoard(nextSessions, nextActiveBoard);
      const nextActiveSessionName = activeSessionNameForVisibleSessions(
        nextVisibleSessions,
        nextActiveBoard,
        activeSessionNameRef.current === sessionName ? null : activeSessionNameRef.current,
      );

      persistBoardState(nextBoardState);
      if (!isUnifiedSource) {
        setSessions(nextSessions);
      }

      if (nextActiveSessionName) {
        setActiveSessionName(nextActiveSessionName);
        const entry = terminalsRef.current.get(nextActiveSessionName);
        if (entry) {
          setActiveTerminal(entry.term, entry.send);
          window.requestAnimationFrame(() => {
            entry.term.focus();
          });
        } else {
          clearActiveTerminal();
        }
      } else {
        setActiveSessionName(null);
        clearActiveTerminal();
      }
    },
    [
      boardState,
      clearActiveTerminal,
      isUnifiedSource,
      persistBoardState,
      sessions,
      setActiveTerminal,
      workspaceId,
    ],
  );

  useEffect(() => {
    register({
      id: `multi-session:${workspaceId}:close-active-pane`,
      keys: [...CLOSE_TERMINAL_PANE_SHORTCUT_KEYS],
      action: () => {
        if (!isPwaStandalone()) return true;
        const target =
          visibleSessions.find((session) => session.sessionName === activeSessionNameRef.current) ??
          visibleSessions[0];
        if (!activeBoard?.key || !target) return false;
        void handleRemovePane({
          boardKey: activeBoard.key,
          boardPaneKey: target.boardPaneKey,
          sessionName: target.sessionName,
        });
        return false;
      },
      description: "Close active terminal pane",
      category: "terminal",
      enabledInBrowser: false,
      global: true,
    });

    return () => unregister(`multi-session:${workspaceId}:close-active-pane`);
  }, [activeBoard?.key, handleRemovePane, register, unregister, visibleSessions, workspaceId]);

  const renderGitFontControls = () => {
    if (!isUnifiedSource) return null;

    return (
      <TerminalFontSizeControls
        className="shrink-0"
        dataTestId="git-terminal-font-size-controls"
        decreaseTestId="decrease-git-terminal-font-size"
        increaseTestId="increase-git-terminal-font-size"
        label="Workspace terminal font size controls"
      />
    );
  };

  const renderGitRepositoryButton = () => {
    if (!isUnifiedSource) return null;

    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => setPaletteOpen(true)}
        className="h-7 min-h-0 px-2 text-xs"
        aria-label="Open workspace command palette"
        data-testid="open-git-session-search"
      >
        <Search className="size-3" />
        Add session
      </Button>
    );
  };

  const renderTerminalSessionRow = (session: WorkspaceSessionPane) => {
    const isOnActiveBoard = activeBoardSessionNames.has(session.sessionName);

    return (
      <button
        type="button"
        key={session.sessionName}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          if (isOnActiveBoard) {
            selectSession(session.sessionName);
          } else {
            handleAddExistingTerminalToBoard(session);
          }
          closeGitSearchModal();
        }}
        data-testid={`select-terminal-session-${session.sessionName}`}
      >
        <TerminalSquare className="size-3 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono">{session.label}</span>
          <span className="block truncate text-[10px] text-muted-foreground">Terminal session</span>
        </span>
        <span className="text-[10px] text-muted-foreground">
          {isOnActiveBoard ? "Focus" : "Add to board"}
        </span>
      </button>
    );
  };

  const renderGitRepositoryRow = (
    repository: GitRepositoryOption,
    options?: { pinnedLabel?: string },
  ) => {
    const repositoryIdentity = gitPaneIdentity(repository.cloneSessionKey, repository.relativePath);
    const repositoryPending = addingCloneKey === repositoryIdentity;

    return (
      <button
        type="button"
        key={repositoryIdentity}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
        onClick={() => void handleAddGitRepository(repository)}
        disabled={repositoryPending}
        data-testid={`add-git-session-${gitRepositoryActionIdentity(repository)}`}
      >
        <Plus className="size-3 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono">{repository.label}</span>
          {options?.pinnedLabel ? (
            <span className="block truncate text-[10px] text-muted-foreground">
              Pinned favorite · {options.pinnedLabel}
            </span>
          ) : null}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {repositoryPending ? "Adding…" : "Add"}
        </span>
      </button>
    );
  };

  const renderGitAddFailureStatus = () =>
    gitAddError ? (
      <p className="text-xs text-destructive" data-testid="git-session-add-error">
        {gitAddError}
      </p>
    ) : null;

  const renderGitRestoreFailureStatus = () =>
    gitRestoreFailed ? (
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-destructive">
        <p data-testid="git-session-restore-error">
          Git panes need refresh. Retry to restore repository panes.
        </p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-7 min-h-0 px-2 text-xs"
          onClick={() => setReloadKey((value) => value + 1)}
          data-testid="retry-git-session-restore"
        >
          Retry Git restore
        </Button>
      </div>
    ) : null;

  const renderGitRepositorySearchModal = () => {
    if (!isUnifiedSource) return null;

    const query = gitSearchQuery.trim();
    const visibleTerminalSessions = filteredTerminalSessions.slice(0, 6);
    const visibleFavorites = favoriteGitRepositories.slice(0, 6);
    const visibleRepositories = filteredGitRepositories.slice(0, 8);
    const hasResults =
      visibleTerminalSessions.length > 0 ||
      visibleFavorites.length > 0 ||
      visibleRepositories.length > 0;

    return (
      <Dialog
        open={gitSearchOpen}
        onOpenChange={(open) => (open ? openGitSearchModal() : closeGitSearchModal())}
      >
        {gitSearchOpen ? (
          <DialogContent className="max-w-xl" data-testid="git-session-search-modal">
            <DialogHeader>
              <DialogTitle>Add workspace session</DialogTitle>
              <DialogDescription>
                Create a plain terminal in the workspace home directory, jump to terminal sessions,
                search repositories, or choose a pinned Git favorite. Open Git panes are hidden from
                repository results.
              </DialogDescription>
            </DialogHeader>
            <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-2 text-sm">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <span className="sr-only">Search terminal sessions and Git repositories</span>
              <input
                ref={gitSearchInputRef}
                type="search"
                value={gitSearchQuery}
                onChange={(event) => setGitSearchQuery(event.target.value)}
                placeholder="Search terminal sessions or Git repositories…"
                className="min-w-0 flex-1 bg-transparent outline-none"
                data-testid="git-session-search"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between"
              onClick={async () => {
                if (await handleCreateSession()) {
                  closeGitSearchModal();
                }
              }}
              disabled={creating}
              data-testid="add-plain-terminal-session"
            >
              <span>Add new terminal session</span>
              <span className="text-xs text-muted-foreground">
                {formatShortcut(CREATE_TERMINAL_SESSION_SHORTCUT_KEYS)}
              </span>
            </Button>
            {renderGitAddFailureStatus()}
            {gitFavoritesFailed ? (
              <p className="text-xs text-muted-foreground" data-testid="git-favorites-error">
                Favorites are unavailable. Search still works.
              </p>
            ) : null}
            <div
              className="max-h-80 space-y-3 overflow-auto"
              data-mobile-scroll-allow="true"
              data-testid="git-session-results"
            >
              {query ? (
                <section
                  aria-label="Terminal session search results"
                  data-testid="terminal-session-results"
                >
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Terminal sessions
                  </div>
                  {visibleTerminalSessions.length > 0 ? (
                    <div className="space-y-1">
                      {visibleTerminalSessions.map((session) => renderTerminalSessionRow(session))}
                    </div>
                  ) : (
                    <p className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">
                      No matching terminal sessions.
                    </p>
                  )}
                </section>
              ) : null}

              <section aria-label="Pinned Git favorites" data-testid="git-session-favorites">
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span>Pinned favorites</span>
                  {gitFavoritesLoading ? <span>Loading…</span> : null}
                </div>
                {visibleFavorites.length > 0 ? (
                  <div className="space-y-1">
                    {visibleFavorites.map((repository) =>
                      renderGitRepositoryRow(repository, { pinnedLabel: repository.favoriteLabel }),
                    )}
                  </div>
                ) : (
                  <p className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">
                    No pinned favorites match this view.
                  </p>
                )}
              </section>

              {query ? (
                <section aria-label="Git repository search results">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Search results
                  </div>
                  {visibleRepositories.length > 0 ? (
                    <div className="space-y-1">
                      {visibleRepositories.map((repository) => renderGitRepositoryRow(repository))}
                    </div>
                  ) : (
                    <p className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">
                      {hasResults
                        ? "No additional matching repositories."
                        : "No matching Git repositories."}
                    </p>
                  )}
                </section>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Type to search terminal sessions and repositories. Use favorites for quick pinned
                  access.
                </p>
              )}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    );
  };

  const renderWorkspaceHeader = () => (
    <>
      <header className="grid min-h-[calc(5.75rem+var(--safe-area-inset-top))] shrink-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-2 gap-y-1 border-b border-sidebar-border px-[max(0.5rem,var(--safe-area-inset-left))] pb-1 pt-[calc(var(--safe-area-inset-top)+0.25rem)] pr-[max(0.5rem,var(--safe-area-inset-right))] min-[1025px]:min-h-14 min-[1025px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] min-[1025px]:grid-rows-1 min-[1025px]:gap-1 min-[1025px]:px-2 min-[1025px]:py-1">
        <div className="flex min-w-0 items-center gap-1" data-testid="workspace-header-left">
          <SidebarTrigger className="h-7 min-h-0 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Active pane</p>
            <p className="truncate font-mono text-xs" data-testid="active-pane-label">
              {activeLabel ?? "No active pane"}
            </p>
          </div>
        </div>
        <div
          className="col-span-2 row-start-2 flex min-w-0 items-center justify-center min-[1025px]:col-span-1 min-[1025px]:col-start-2 min-[1025px]:row-start-1"
          data-testid="workspace-header-board-controls"
        >
          {renderBoardBar()}
        </div>
        <div
          className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-1 min-[1025px]:col-start-3"
          data-testid="workspace-header-right"
        >
          <span className="sr-only" data-testid="multi-session-pane-count">
            {visibleSessions.length}
          </span>
          {renderGitFontControls()}
          {renderGitRepositoryButton()}
          {canCreateSession && !isUnifiedSource ? (
            <Button
              type="button"
              size="xs"
              onClick={() => void handleCreateSession()}
              disabled={creating}
              className="h-7 min-h-0 px-2 text-xs"
              data-testid={
                sessions.length === 0 ? "create-empty-session-button" : "create-session-button"
              }
            >
              <Plus className="size-3" />
              {creating ? "Creating…" : "New"}
            </Button>
          ) : null}
        </div>
      </header>
      {renderGitRepositorySearchModal()}
      {renderGitAddFailureStatus()}
      {renderGitRestoreFailureStatus()}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        tabs={isUnifiedSource ? [] : commandPaletteTabs}
        onSelectTab={handlePaletteSelect}
        onCreateSession={isUnifiedSource ? undefined : () => void handleCreateSession()}
        actions={workspacePaletteActions}
        searchValue={isUnifiedSource ? gitSearchQuery : undefined}
        onSearchValueChange={isUnifiedSource ? setGitSearchQuery : undefined}
        searchPlaceholder={
          isUnifiedSource
            ? "Search terminal sessions, Git repositories, or type a new session name…"
            : "Search workspace sessions…"
        }
        emptyText={isUnifiedSource ? "No command matches." : "No workspace sessions found."}
        groupHeading="Workspace sessions"
      />
    </>
  );

  const renderEmptyWorkspaceBody = () => (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center"
      data-testid="active-board-empty"
    >
      <p className="text-sm font-medium text-foreground">This workspace has no panes yet.</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {source === "unified"
          ? "Use Add session to place a terminal or Git repository in this workspace."
          : "Create a tmux-backed terminal session to start using this workspace."}
      </p>
    </div>
  );

  const controlsSelectionModeEnabled = isComposeSheet && selectionModeEnabled;
  const hasActiveTerminal = Boolean(activeTerminalEntry?.term);
  const hasActiveSender = Boolean(activeTerminalEntry?.send);
  const mobileClipboardStatus = clipboardStatusText(clipboardActionStatus, {
    canPaste: hasActiveSender,
    hasTerminal: hasActiveTerminal,
    selectionModeEnabled: controlsSelectionModeEnabled,
  });
  const mobileTerminalControls = isComposeSheet ? (
    <MobileTerminalControls
      isKeyboardVisible={isMobileKeyboardVisible}
      onHapticFeedback={triggerHapticFeedback}
      windowNavigation={mobileWindowNavigation}
      hasSelection={hasTerminalSelection}
      selectionModeEnabled={controlsSelectionModeEnabled}
      onToggleSelectionMode={handleSelectionModeChange}
      onCopy={handleMobileCopy}
      onPaste={handleMobilePaste}
      clipboardStatusText={mobileClipboardStatus}
      selectionModeDisabledReason={hasActiveTerminal ? undefined : "Terminal is not ready"}
      copyDisabledReason={
        hasActiveTerminal
          ? hasTerminalSelection
            ? undefined
            : "Select terminal text before copying"
          : "Terminal is not ready"
      }
      pasteDisabledReason={
        hasActiveSender ? undefined : "Paste is unavailable until the terminal sender is ready"
      }
    />
  ) : null;
  const desktopComposePanel =
    composeOpen && !isComposeSheet ? (
      <div className="h-72 min-h-56 shrink-0 p-1 pt-0" data-testid="multi-session-compose-inline">
        <TerminalSessionCompose
          variant="inline"
          initialDraft={composeDraft}
          targetLabel={composeTargetLabel ?? activeLabel}
          onSend={sendComposeDraft}
          onClose={closeCompose}
        />
      </div>
    ) : null;
  const mobileComposeSheet = isComposeSheet ? (
    <TerminalSessionCompose
      variant="sheet"
      open={composeOpen}
      onOpenChange={(open) => {
        if (open) {
          setComposeOpen(true);
        } else {
          closeCompose();
        }
      }}
      isKeyboardVisible={isMobileKeyboardVisible}
      initialDraft={composeDraft}
      targetLabel={composeTargetLabel ?? activeLabel}
      onSend={sendComposeDraft}
      onClose={closeCompose}
    />
  ) : null;
  const composeLockedSessionName = composeOpen
    ? (composeTargetSessionName ?? activeSessionName)
    : null;

  const renderPane = (pane: SessionPane, model: WorkspaceBoardRenderModel) => {
    const toolPane = model.toolPanes.find((candidate) => candidate.key === pane.sessionName);
    if (toolPane) {
      const paneStyle: CSSProperties = { gridArea: pane.gridArea };
      return (
        <TerminalSessionFrame
          key={`${model.board.key}:${toolPane.key}`}
          label={toolPane.label}
          active={false}
          dataTestId={`workspace-tool-pane-${toolPane.tool}`}
          layoutMode="tiled"
          style={paneStyle}
          headerActions={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 min-h-0 px-1.5 text-[10px] text-white hover:bg-white/10 hover:text-white"
              aria-label={`Open ${toolPane.label} in a new tab`}
              data-testid={`pop-out-workspace-tool-${toolPane.tool}`}
              onClick={(event) => {
                event.stopPropagation();
                window.open(toolPane.url, "_blank", "noopener,noreferrer");
              }}
            >
              <ExternalLink className="size-3" />
              Pop Out
            </Button>
          }
          onActivate={() => {
            selectSession(toolPane.sourceSessionName, { focusTerminal: false });
          }}
          closeLabel={`Close ${toolPane.label}`}
          closeTestId={`remove-workspace-tool-${toolPane.tool}`}
          onClose={(event) => {
            event.stopPropagation();
            setWorkspaceToolPanes((current) =>
              current.filter((candidate) => candidate.key !== toolPane.key),
            );
          }}
        >
          <iframe
            src={toolPane.url}
            title={toolPane.label}
            className="min-h-0 flex-1 border-0 bg-background"
            allow="clipboard-read; clipboard-write"
            sandbox={
              toolPane.url.startsWith("/api/workspace-proxy/")
                ? "allow-downloads allow-forms allow-modals allow-popups allow-scripts"
                : "allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            }
            data-testid={`workspace-tool-frame-${toolPane.tool}`}
          />
        </TerminalSessionFrame>
      );
    }

    const visibleSession = model.visibleSessions.find(
      (candidate) => candidate.sessionName === pane.sessionName,
    );
    const session =
      visibleSession ?? sessions.find((candidate) => candidate.sessionName === pane.sessionName);
    const isActive = model.isActive && pane.sessionName === activeSessionName;
    const isComposeDisabled =
      Boolean(composeLockedSessionName) && pane.sessionName !== composeLockedSessionName;
    const cloneSessionKey = session?.cloneSessionKey;
    const relativePath = session?.relativePath;
    const boardPaneSignal = visibleSession?.boardPaneKey ?? pane.id;
    const boardPaneKind = visibleSession?.boardPaneKind ?? "terminal";
    const refreshCloneTerminalIdentity =
      session && cloneSessionKey && relativePath
        ? () =>
            refreshGitPaneCloneTerminalIdentity(
              session.sessionName,
              cloneSessionKey,
              relativePath,
              boardPaneSignal,
            )
        : undefined;
    const visualViewportSignal = visualKeyboardVisible
      ? `keyboard:${visualViewportHeightPx}:${visualViewportOffsetTopPx}`
      : `viewport:${visualViewportHeightPx}:${visualViewportOffsetTopPx}`;
    const layoutSignal = `${model.board.key}:${boardPaneSignal}:${model.layout.tiled.rows}:${model.layout.tiled.columns}:${pane.gridArea}:${visualViewportSignal}`;
    const paneStyle: CSSProperties = { gridArea: pane.gridArea };

    return (
      <TerminalSessionFrame
        key={`${model.board.key}:${pane.id}`}
        label={pane.label}
        active={isActive}
        dataTestId={
          model.isActive ? `workspace-${pane.id}` : `workspace-${model.board.key}-${pane.id}`
        }
        layoutMode="tiled"
        style={paneStyle}
        disabled={isComposeDisabled}
        disabledLabel="Compose locked"
        headerActions={
          session ? (
            <WorkspaceSessionTools
              workspaceId={workspaceId}
              sessionName={session.sessionName}
              label={session.label}
              fallbackPath={session.clonePath}
              onOpenTool={(request: WorkspaceToolOpenRequest) => {
                openWorkspaceToolPane(model.board.key, session, request.tool, request.urls);
              }}
            />
          ) : null
        }
        onActivate={() => {
          if (!model.isActive) {
            persistBoardState(selectWorkspaceBoard(boardState, model.board.key));
          }
          selectSession(pane.sessionName);
        }}
        onFocusActivate
        closeLabel={`${isUnifiedSource ? "Remove" : "Close"} ${pane.label}`}
        closeTestId={
          model.isActive ? `remove-pane-${pane.id}` : `remove-pane-${model.board.key}-${pane.id}`
        }
        onClose={(event) => {
          event.stopPropagation();
          void handleRemovePane({
            boardKey: model.board.key,
            boardPaneKey: visibleSession?.boardPaneKey,
            sessionName: pane.sessionName,
          });
        }}
        onMouseEnter={() => {
          if (model.isActive && !isComposeDisabled) selectSession(pane.sessionName);
        }}
      >
        <InteractiveTerminal
          agentId={agentId}
          workspaceId={workspaceId}
          sessionName={pane.sessionName}
          clonePath={session?.clonePath}
          cloneProof={session?.cloneProof}
          refreshCloneTerminalIdentity={refreshCloneTerminalIdentity}
          className="min-h-0 flex-1"
          layoutSignal={layoutSignal}
          mobileInputMode={isComposeSheet}
          suppressAutoFocus={workspaceHealthLoading}
          pinToBottomOnResize={isComposeSheet}
          selectionModeEnabled={controlsSelectionModeEnabled}
          onConnectionStateChange={(state) =>
            handlePaneConnectionStateChange(boardPaneSignal, boardPaneKind, state)
          }
          onRecoveryStateChange={(state) =>
            handlePaneRecoveryStateChange(boardPaneSignal, boardPaneKind, state)
          }
          onTerminalReady={(term, send) => handleTerminalReady(pane.sessionName, term, send)}
          onTerminalDestroy={() => {
            handleTerminalDestroy(pane.sessionName);
            clearPaneRecoveryState(boardPaneSignal);
          }}
          onUserFocusRequest={() => {
            if (!model.isActive) {
              persistBoardState(selectWorkspaceBoard(boardState, model.board.key));
            }
            selectSession(pane.sessionName, { focusTerminal: false });
          }}
          onComposeRequest={(request) => {
            openComposeWithDraft(request, pane.sessionName);
          }}
          onClipboardStatus={handleClipboardActionStatus}
          targetLabel={pane.label}
        />
      </TerminalSessionFrame>
    );
  };

  const renderBoardLayer = (model: WorkspaceBoardRenderModel) => {
    if (model.visibleSessions.length === 0 && model.toolPanes.length === 0) {
      return model.isActive ? (
        <div key={model.board.key} className="absolute inset-1">
          {renderEmptyWorkspaceBody()}
        </div>
      ) : null;
    }

    return (
      <div
        key={model.board.key}
        className={cn(
          "absolute inset-1 grid min-h-0 gap-1",
          workspaceHealthLoading && "pointer-events-none opacity-0",
          !model.isActive && "pointer-events-none opacity-0",
        )}
        style={{
          gridTemplateColumns: model.layout.tiled.gridTemplateColumns,
          gridTemplateRows: model.layout.tiled.gridTemplateRows,
        }}
        data-testid={
          model.isActive ? "multi-session-grid" : `multi-session-grid-${model.board.key}`
        }
        data-board-key={model.board.key}
        data-board-active={model.isActive ? "true" : "false"}
        aria-hidden={model.isActive && !workspaceHealthLoading ? undefined : true}
      >
        {model.layout.panes.map((pane) => renderPane(pane, model))}
      </div>
    );
  };

  const wrapMobileWorkspace = (content: ReactNode) =>
    isComposeSheet ? (
      <MobileTerminalShell
        isKeyboardVisible={isMobileKeyboardVisible}
        reserveDashboardTrigger={false}
        stopKeyboardPropagation={false}
      >
        {content}
      </MobileTerminalShell>
    ) : (
      content
    );

  if (loading) {
    const loadingState = (
      <div
        className={cn("flex h-full items-center justify-center bg-background", className)}
        data-testid="multi-session-loading"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading workspace sessions…
        </div>
      </div>
    );
    return wrapMobileWorkspace(loadingState);
  }

  if (loadFailed) {
    const failedState = (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center",
          className,
        )}
      >
        <Alert variant="destructive" data-testid="session-load-error" className="max-w-md">
          <AlertCircle />
          <AlertTitle>Could not load terminal sessions.</AlertTitle>
          <AlertDescription>
            Retry to inspect workspace sessions. Existing terminals were not mounted from stale
            data.
          </AlertDescription>
        </Alert>
        <Button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          data-testid="retry-load-sessions"
        >
          Retry
        </Button>
      </div>
    );
    return wrapMobileWorkspace(failedState);
  }

  const isEmptyWorkspace = sessions.length === 0;

  const workspace = (
    <section
      ref={workspaceRootRef}
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-testid={isEmptyWorkspace ? "multi-session-empty" : "multi-session-workspace"}
      data-session-source={source}
      aria-label={
        source === "unified" ? "Workspace terminal sessions" : "Multi-session terminal workspace"
      }
      onKeyDown={handleWorkspaceKeyDown}
    >
      {renderWorkspaceHeader()}
      {renderWorkspaceRecoveryStatus()}

      {createFailed ? (
        <Alert variant="destructive" data-testid="session-create-error" className="m-3 mb-0">
          <AlertCircle />
          <AlertTitle>Could not create a terminal session.</AlertTitle>
          <AlertDescription>
            Existing panes remain mounted and selected state is unchanged.
          </AlertDescription>
        </Alert>
      ) : null}

      {terminalCloseFailed ? (
        <Alert
          variant="destructive"
          data-testid="terminal-session-close-error"
          className="m-3 mb-0"
        >
          <AlertCircle />
          <AlertTitle>Could not close terminal.</AlertTitle>
          <AlertDescription>
            The pane was removed locally, but the backing terminal may still exist. Refresh and try
            again.
          </AlertDescription>
        </Alert>
      ) : null}

      {layoutPersistenceMessage ? (
        <p
          className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
          data-layout-codes={layoutPersistenceCodes}
          data-testid="layout-persistence-status"
        >
          {layoutPersistenceMessage}
        </p>
      ) : null}

      {renderBoardPersistenceStatus()}

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={workspaceBodyRef}
          className="relative min-h-0 flex-1 overflow-hidden p-1"
          data-testid="multi-session-body"
        >
          {boardRenderModels.map(renderBoardLayer)}
          {workspaceHealthLoading ? (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center bg-background"
              data-testid="multi-session-loading"
              data-workspace-loading-phase="health"
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading workspace sessions…
              </div>
            </div>
          ) : null}
        </div>
        {mobileTerminalControls}
        {desktopComposePanel}
      </div>
      {mobileComposeSheet}
    </section>
  );

  return wrapMobileWorkspace(workspace);
}
