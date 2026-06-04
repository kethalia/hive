"use client";

import type { Terminal } from "@xterm/xterm";
import { AlertCircle, Loader2, Minus, Plus, Search, X } from "lucide-react";
import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CommandPalette } from "@/components/terminal/CommandPalette";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { listGitClonesAction, resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import {
  listNavigationFavoritesAction,
  type NavigationFavoriteDto,
} from "@/lib/actions/navigation-favorites";
import { createSessionAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import type { GitCloneTerminalIdentity, PublicCloneTree } from "@/lib/git/clone-actions-contract";
import type { CloneTreeNode, CloneTreeRepositoryNode } from "@/lib/git/clone-tree";
import { cn } from "@/lib/utils";
import {
  type PersistedSessionPane,
  resolveSessionPaneLayout,
  SESSION_PANE_LAYOUT_VERSION,
  type SessionPane,
  type SessionPaneLayoutDiagnostic,
} from "@/lib/workspaces/session-pane-layout";

interface InteractiveTerminalComponentProps {
  agentId: string;
  workspaceId: string;
  sessionName: string;
  clonePath?: string;
  cloneProof?: string;
  className?: string;
  onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
  onTerminalDestroy?: () => void;
  layoutSignal?: unknown;
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
  source?: "workspace" | "git";
}

type SessionLoadResult =
  | { status: "success"; sessions: WorkspaceSessionPane[]; repositories?: GitRepositoryOption[] }
  | { status: "empty"; repositories?: GitRepositoryOption[] }
  | { status: "failure"; repositories?: GitRepositoryOption[] };

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

const ADD_SESSION_MODAL_SHORTCUT_KEYS = ["ctrl+n", "cmd+n"] as const;
const CREATE_TERMINAL_SESSION_SHORTCUT_KEYS = ["ctrl+shift+n", "cmd+shift+n"] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    if (!isObjectRecord(parsed) || !Array.isArray(parsed.panes)) return [];

    return parsed.panes.flatMap((pane): PersistedGitPaneRef[] => {
      if (!isObjectRecord(pane)) return [];
      const cloneSessionKey = normalizeSessionName(pane.cloneSessionKey);
      const relativePath = normalizeSessionName(pane.relativePath);
      if (!cloneSessionKey || !relativePath) return [];
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

function storageKeyForWorkspace(workspaceId: string, source: "workspace" | "git"): string {
  return `multi-session-layout:${source}:${workspaceId}`;
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
  if (diagnostics.some((diagnostic) => diagnostic.code === "stale-pane-dropped")) {
    return "Stored layout referenced closed sessions and was repaired.";
  }
  return null;
}

function moveByIndex<T>(values: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= values.length) return [...values];
  const safeToIndex = Math.min(Math.max(toIndex, 0), values.length - 1);
  if (fromIndex === safeToIndex) return [...values];

  const next = [...values];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return [...values];
  next.splice(safeToIndex, 0, item);
  return next;
}

function isTextEntryElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;

  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
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
  if (repositories.length === 0) return { status: "empty", repositories };

  const repositoryByKey = new Map(
    repositories.map((repository) => [repository.cloneSessionKey, repository]),
  );
  const selectedRefs = readPersistedGitPaneRefs(persistedJson).filter((ref) =>
    repositoryByKey.has(ref.cloneSessionKey),
  );
  if (selectedRefs.length === 0) return { status: "empty", repositories };

  const resolved = await Promise.allSettled(
    selectedRefs.map(async (ref): Promise<WorkspaceSessionPane | null> => {
      const repository = repositoryByKey.get(ref.cloneSessionKey);
      if (!repository) return null;

      const identity = unwrapActionData(
        await resolveGitCloneTerminalAction({
          agentId,
          workspaceId,
          cloneSessionKey: repository.cloneSessionKey,
          relativePath: repository.relativePath,
        }),
      );
      if (!isGitCloneTerminalIdentity(identity)) return null;
      return {
        sessionName: identity.sessionName,
        label: ref.label ?? repository.label,
        clonePath: identity.clonePath,
        cloneProof: identity.cloneProof,
        cloneSessionKey: repository.cloneSessionKey,
        relativePath: repository.relativePath,
      };
    }),
  );

  const sessions = uniqueSessions(
    resolved.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    ),
  );

  return sessions.length > 0
    ? { status: "success", sessions, repositories }
    : { status: "empty", repositories };
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

  if (sessions.length > 0) return { status: "success", sessions, repositories };
  if (workspaceLoad.status === "failure" && gitLoad.status === "failure") {
    return { status: "failure", repositories };
  }
  return { status: "empty", repositories };
}

export function MultiSessionWorkspace({
  agentId,
  workspaceId,
  className,
  source = "workspace",
}: MultiSessionWorkspaceProps) {
  const { register, setActiveTerminal, unregister } = useKeybindings();
  const {
    size: fontSize,
    increase: increaseFontSize,
    decrease: decreaseFontSize,
    canIncrease: canIncreaseFontSize,
    canDecrease: canDecreaseFontSize,
  } = useTerminalFontStep();
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
  const [gitSearchQuery, setGitSearchQuery] = useState("");
  const [addingCloneKey, setAddingCloneKey] = useState<string | null>(null);
  const [gitAddFailed, setGitAddFailed] = useState(false);
  const [persistedLayoutJson, setPersistedLayoutJson] = useState<string | null>(null);
  const [layoutPersistenceNotice, setLayoutPersistenceNotice] =
    useState<LayoutPersistenceNotice | null>(null);
  const terminalsRef = useRef<Map<string, TerminalEntry>>(new Map());
  const activeSessionNameRef = useRef<string | null>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);
  const gitSearchInputRef = useRef<HTMLInputElement>(null);
  const canCreateSession = true;
  const isGitSource = source === "git";

  activeSessionNameRef.current = activeSessionName;

  const layout = useMemo(
    () =>
      resolveSessionPaneLayout({
        sessions: sessions.map((session) => ({
          sessionName: session.sessionName,
          label: session.label,
        })),
        persistedJson: persistedLayoutJson,
      }),
    [persistedLayoutJson, sessions],
  );
  const activeLabel = sessions.find((session) => session.sessionName === activeSessionName)?.label;
  const openCloneKeys = useMemo(
    () => new Set(sessions.map((session) => session.cloneSessionKey).filter(Boolean)),
    [sessions],
  );
  const favoriteGitRepositories = useMemo(() => {
    const repositoryByKey = new Map(
      gitRepositories.map((repository) => [repository.cloneSessionKey, repository]),
    );
    const seen = new Set<string>();
    const query = gitSearchQuery.trim().toLowerCase();

    return gitFavorites.flatMap((favorite): GitFavoriteRepositoryOption[] => {
      if (favorite.kind !== "git" || favorite.workspaceId !== workspaceId) return [];
      if (!favorite.relativePath || seen.has(favorite.targetKey)) return [];
      const repository = repositoryByKey.get(favorite.targetKey);
      if (!repository || repository.relativePath !== favorite.relativePath) return [];
      if (openCloneKeys.has(repository.cloneSessionKey)) return [];
      if (
        query &&
        !repository.label.toLowerCase().includes(query) &&
        !repository.relativePath.toLowerCase().includes(query) &&
        !(favorite.label ?? "").toLowerCase().includes(query)
      ) {
        return [];
      }
      seen.add(favorite.targetKey);
      return [
        {
          ...repository,
          favoriteLabel: favorite.label?.trim() || repository.label,
        },
      ];
    });
  }, [gitFavorites, gitRepositories, gitSearchQuery, openCloneKeys, workspaceId]);
  const favoriteCloneKeys = useMemo(
    () => new Set(favoriteGitRepositories.map((repository) => repository.cloneSessionKey)),
    [favoriteGitRepositories],
  );
  const filteredGitRepositories = useMemo(() => {
    const query = gitSearchQuery.trim().toLowerCase();
    return gitRepositories.filter((repository) => {
      if (openCloneKeys.has(repository.cloneSessionKey)) return false;
      if (favoriteCloneKeys.has(repository.cloneSessionKey)) return false;
      if (!query) return false;
      return (
        repository.label.toLowerCase().includes(query) ||
        repository.relativePath.toLowerCase().includes(query)
      );
    });
  }, [favoriteCloneKeys, gitRepositories, gitSearchQuery, openCloneKeys]);
  const layoutPersistenceMessage = buildLayoutPersistenceMessage(
    layoutPersistenceNotice,
    layout.diagnostics,
  );
  const layoutPersistenceCodes = [
    ...(layoutPersistenceNotice ? [layoutPersistenceNotice.code] : []),
    ...layout.diagnostics.map((diagnostic) => diagnostic.code),
  ].join(" ");

  const clearActiveTerminal = useCallback(() => {
    setActiveTerminal(null, null);
  }, [setActiveTerminal]);

  const selectSession = useCallback(
    (sessionName: string) => {
      setActiveSessionName(sessionName);
      const entry = terminalsRef.current.get(sessionName);
      if (entry) {
        setActiveTerminal(entry.term, entry.send);
        entry.term.focus();
        return;
      }
      clearActiveTerminal();
    },
    [clearActiveTerminal, setActiveTerminal],
  );
  const commandPaletteTabs = useMemo(
    () => sessions.map((session) => ({ id: session.sessionName, sessionName: session.label })),
    [sessions],
  );
  const handlePaletteSelect = useCallback(
    (sessionName: string) => {
      selectSession(sessionName);
    },
    [selectSession],
  );

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

  const handleTerminalReady = useCallback(
    (sessionName: string, term: Terminal, send: (data: string) => void) => {
      terminalsRef.current.set(sessionName, { term, send });
      if (activeSessionNameRef.current === sessionName) {
        setActiveTerminal(term, send);
        term.focus();
      }
    },
    [setActiveTerminal],
  );

  const handleTerminalDestroy = useCallback(
    (sessionName: string) => {
      terminalsRef.current.delete(sessionName);
      if (activeSessionNameRef.current === sessionName) {
        clearActiveTerminal();
      }
    },
    [clearActiveTerminal],
  );

  const moveSession = useCallback(
    (sessionName: string, direction: -1 | 1) => {
      setSessions((current) => {
        const fromIndex = current.findIndex((session) => session.sessionName === sessionName);
        const next = moveByIndex(current, fromIndex, fromIndex + direction);
        persistSessionOrder(next, sessionName);
        return next;
      });
      selectSession(sessionName);
    },
    [persistSessionOrder, selectSession],
  );

  const focusRelativeSession = useCallback(
    (direction: -1 | 1) => {
      if (sessions.length === 0) return;
      const currentIndex = Math.max(
        0,
        sessions.findIndex((session) => session.sessionName === activeSessionNameRef.current),
      );
      const nextIndex = (currentIndex + direction + sessions.length) % sessions.length;
      selectSession(sessions[nextIndex].sessionName);
    },
    [selectSession, sessions],
  );

  const openGitSearchModal = useCallback(() => {
    if (!isGitSource) return;
    setGitSearchOpen(true);
    setGitAddFailed(false);
  }, [isGitSource]);

  const closeGitSearchModal = useCallback(() => {
    setGitSearchOpen(false);
    setGitSearchQuery("");
    setGitAddFailed(false);
  }, []);

  const handleWorkspaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (isTextEntryElement(target)) return;

      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        focusRelativeSession(-1);
        return;
      }

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        focusRelativeSession(1);
      }
    },
    [focusRelativeSession],
  );

  const handleResetLayout = useCallback(() => {
    persistLayoutJson(null);
    setSessions((current) =>
      [...current].sort((left, right) => left.label.localeCompare(right.label)),
    );
  }, [persistLayoutJson]);

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
      id: "command-palette",
      keys: ["ctrl+k", "cmd+k"],
      action: () => {
        setPaletteOpen(true);
        return false;
      },
      description: "Open command palette",
      category: "terminal",
      enabledInBrowser: true,
      global: true,
    });

    if (isGitSource) {
      register({
        id: `multi-session:${workspaceId}:open-session-search`,
        keys: [...ADD_SESSION_MODAL_SHORTCUT_KEYS],
        action: () => {
          openGitSearchModal();
          return false;
        },
        description: "Open workspace session search",
        category: "terminal",
        enabledInBrowser: true,
        global: true,
      });
    }

    return () => {
      unregister(`multi-session:${workspaceId}:previous-pane`);
      unregister(`multi-session:${workspaceId}:next-pane`);
      unregister("command-palette");
      unregister(`multi-session:${workspaceId}:open-session-search`);
    };
  }, [focusRelativeSession, isGitSource, openGitSearchModal, register, unregister, workspaceId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual retry trigger for session loading
  useEffect(() => {
    const storageKey = storageKeyForWorkspace(workspaceId, source);
    const storedLayout = readWorkspaceLayoutStorage(storageKey);
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
    setGitAddFailed(false);
    setPersistedLayoutJson(storedLayout.raw);
    setLayoutPersistenceNotice(storedLayout.notice);
    terminalsRef.current.clear();
    clearActiveTerminal();

    async function loadSessions() {
      try {
        const parsed =
          source === "git"
            ? await loadUnifiedWorkspaceSessions(workspaceId, agentId, storedLayout.raw)
            : await loadWorkspaceSessions(workspaceId);
        if (cancelled) return;

        setGitRepositories(parsed.repositories ?? []);

        if (parsed.status === "success") {
          setSessions(parsed.sessions);
          const restoredActiveSession = parsed.sessions.find(
            (session) => session.sessionName === storedActiveSessionName,
          );
          setActiveSessionName(
            restoredActiveSession?.sessionName ?? parsed.sessions[0].sessionName,
          );
          return;
        }

        if (parsed.status === "empty") {
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
      clearActiveTerminal();
    };
  }, [agentId, clearActiveTerminal, reloadKey, source, workspaceId]);

  useEffect(() => {
    if (!gitSearchOpen) return;
    window.requestAnimationFrame(() => gitSearchInputRef.current?.focus());
  }, [gitSearchOpen]);

  useEffect(() => {
    if (!isGitSource || !gitSearchOpen) return;

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
  }, [gitSearchOpen, isGitSource, workspaceId]);

  const handleCreateSession = useCallback(async (): Promise<boolean> => {
    if (!canCreateSession) return false;
    setCreating(true);
    setCreateFailed(false);

    try {
      const result = await createSessionAction({ workspaceId });
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
      selectSession(parsed.session.sessionName);
      window.dispatchEvent(new CustomEvent("hive:sidebar-refresh", { detail: { workspaceId } }));
      return true;
    } catch {
      setCreateFailed(true);
      return false;
    } finally {
      setCreating(false);
    }
  }, [persistSessionOrder, selectSession, workspaceId]);

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
      if (!isGitSource) return;
      setAddingCloneKey(repository.cloneSessionKey);
      setGitAddFailed(false);

      try {
        const identity = unwrapActionData(
          await resolveGitCloneTerminalAction({
            agentId,
            workspaceId,
            cloneSessionKey: repository.cloneSessionKey,
            relativePath: repository.relativePath,
          }),
        );
        if (!isGitCloneTerminalIdentity(identity)) {
          setGitAddFailed(true);
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
        selectSession(session.sessionName);
        setGitSearchOpen(false);
        setGitSearchQuery("");
      } catch {
        setGitAddFailed(true);
      } finally {
        setAddingCloneKey(null);
      }
    },
    [agentId, isGitSource, persistSessionOrder, selectSession, workspaceId],
  );

  const handleRemoveGitSession = useCallback(
    (sessionName: string) => {
      if (!isGitSource) return;

      const nextSessions = sessions.filter((session) => session.sessionName !== sessionName);
      const nextActiveSessionName = nextSessions[0]?.sessionName ?? null;
      setSessions(nextSessions);
      persistSessionOrder(nextSessions, nextActiveSessionName);

      if (activeSessionNameRef.current === sessionName) {
        if (nextActiveSessionName) {
          selectSession(nextActiveSessionName);
        } else {
          setActiveSessionName(null);
          clearActiveTerminal();
        }
      }
    },
    [clearActiveTerminal, isGitSource, persistSessionOrder, selectSession, sessions],
  );

  const renderGitFontControls = () => {
    if (!isGitSource) return null;

    return (
      <fieldset
        className="flex min-w-0 items-center gap-1 rounded-md border border-border px-1 py-0.5"
        data-testid="git-terminal-font-size-controls"
      >
        <legend className="sr-only">Workspace terminal font size controls</legend>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 min-h-0 px-1.5 text-[10px]"
          onClick={decreaseFontSize}
          disabled={!canDecreaseFontSize}
          aria-label="Decrease workspace terminal font size"
          data-testid="decrease-git-terminal-font-size"
        >
          <Minus className="size-3" />
        </Button>
        <span className="min-w-10 text-center text-[10px] tabular-nums text-muted-foreground">
          {fontSize}px
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 min-h-0 px-1.5 text-[10px]"
          onClick={increaseFontSize}
          disabled={!canIncreaseFontSize}
          aria-label="Increase workspace terminal font size"
          data-testid="increase-git-terminal-font-size"
        >
          <Plus className="size-3" />
        </Button>
      </fieldset>
    );
  };

  const renderGitRepositoryButton = () => {
    if (!isGitSource) return null;

    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={openGitSearchModal}
        className="h-7 min-h-0 px-2 text-xs"
        aria-label="Add workspace session"
        data-testid="open-git-session-search"
      >
        <Search className="size-3" />
        Add session
        <span className="ml-1 hidden text-[10px] text-muted-foreground sm:inline">
          {formatShortcut(ADD_SESSION_MODAL_SHORTCUT_KEYS)}
        </span>
      </Button>
    );
  };

  const renderGitRepositoryRow = (
    repository: GitRepositoryOption,
    options?: { pinnedLabel?: string },
  ) => (
    <button
      type="button"
      key={repository.cloneSessionKey}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
      onClick={() => void handleAddGitRepository(repository)}
      disabled={addingCloneKey === repository.cloneSessionKey}
      data-testid={`add-git-session-${repository.cloneSessionKey}`}
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
        {addingCloneKey === repository.cloneSessionKey ? "Adding…" : "Add"}
      </span>
    </button>
  );

  const renderGitRepositorySearchModal = () => {
    if (!isGitSource) return null;

    const query = gitSearchQuery.trim();
    const visibleFavorites = favoriteGitRepositories.slice(0, 6);
    const visibleRepositories = filteredGitRepositories.slice(0, 8);
    const hasResults = visibleFavorites.length > 0 || visibleRepositories.length > 0;

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
                Create a plain terminal in the workspace home directory, search repositories, or
                choose a pinned Git favorite. Open panes are hidden from this list.
              </DialogDescription>
            </DialogHeader>
            <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-2 text-sm">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <span className="sr-only">Search Git repositories</span>
              <input
                ref={gitSearchInputRef}
                type="search"
                value={gitSearchQuery}
                onChange={(event) => setGitSearchQuery(event.target.value)}
                placeholder="Search Git repositories to add…"
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
            {gitAddFailed ? (
              <p className="text-xs text-destructive" data-testid="git-session-add-error">
                Could not add Git terminal. No terminal contents or clone proof were logged.
              </p>
            ) : null}
            {gitFavoritesFailed ? (
              <p className="text-xs text-muted-foreground" data-testid="git-favorites-error">
                Favorites are unavailable. Search still works.
              </p>
            ) : null}
            <div className="max-h-80 space-y-3 overflow-auto" data-testid="git-session-results">
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
                  Type to search all repositories. Use favorites for quick pinned access.
                </p>
              )}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    );
  };

  const renderPane = (pane: SessionPane) => {
    const session = sessions.find((candidate) => candidate.sessionName === pane.sessionName);
    const isActive = pane.sessionName === activeSessionName;
    const layoutSignal = `${layout.tiled.rows}:${layout.tiled.columns}:${pane.gridArea}`;
    const paneStyle: CSSProperties = { gridArea: pane.gridArea };

    return (
      // biome-ignore lint/a11y/useSemanticElements: selectable tile wraps a terminal surface, so a native button would be invalid
      <div
        key={pane.id}
        aria-label={`Terminal pane ${pane.label}`}
        aria-current={isActive ? "true" : undefined}
        aria-pressed={isActive}
        role="button"
        className={cn(
          "min-h-0 resize-none overflow-hidden rounded-lg border bg-black shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          isActive ? "border-primary ring-1 ring-primary" : "border-border",
        )}
        data-testid={`workspace-${pane.id}`}
        data-active={isActive ? "true" : "false"}
        data-pane-mode="tiled"
        style={paneStyle}
        tabIndex={0}
        onMouseEnter={() => selectSession(pane.sessionName)}
        onClick={() => selectSession(pane.sessionName)}
        onFocus={() => selectSession(pane.sessionName)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectSession(pane.sessionName);
          }
        }}
      >
        <div className="flex min-h-8 items-center gap-1 border-b border-white/10 bg-zinc-950 px-1.5 py-1 text-white">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{pane.label}</span>
          <span className="rounded bg-white/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-white/80">
            {isActive ? "Active" : "Idle"}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="h-6 min-h-0 px-1.5 text-[10px]"
            aria-label={`Move ${pane.label} left`}
            data-testid={`move-pane-left-${pane.id}`}
            onClick={(event) => {
              event.stopPropagation();
              moveSession(pane.sessionName, -1);
            }}
          >
            ←
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="h-6 min-h-0 px-1.5 text-[10px]"
            aria-label={`Move ${pane.label} right`}
            data-testid={`move-pane-right-${pane.id}`}
            onClick={(event) => {
              event.stopPropagation();
              moveSession(pane.sessionName, 1);
            }}
          >
            →
          </Button>
          {isGitSource ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 min-h-0 px-1.5 text-[10px]"
              aria-label={`Remove ${pane.label}`}
              data-testid={`remove-pane-${pane.id}`}
              onClick={(event) => {
                event.stopPropagation();
                handleRemoveGitSession(pane.sessionName);
              }}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
        <InteractiveTerminal
          agentId={agentId}
          workspaceId={workspaceId}
          sessionName={pane.sessionName}
          clonePath={session?.clonePath}
          cloneProof={session?.cloneProof}
          className="h-[calc(100%-2rem)]"
          layoutSignal={layoutSignal}
          onTerminalReady={(term, send) => handleTerminalReady(pane.sessionName, term, send)}
          onTerminalDestroy={() => handleTerminalDestroy(pane.sessionName)}
        />
      </div>
    );
  };

  if (loading) {
    return (
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
  }

  if (loadFailed) {
    return (
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
  }

  if (sessions.length === 0) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center",
          className,
        )}
        data-testid="multi-session-empty"
      >
        <p className="text-sm font-medium text-foreground">No workspace sessions open</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {source === "git"
            ? "Create a plain terminal session or search Git repositories and add only the panes you need."
            : "Create a tmux-backed terminal session for this workspace."}
        </p>
        {renderGitRepositoryButton()}
        {renderGitRepositorySearchModal()}
        {createFailed ? (
          <Alert variant="destructive" data-testid="session-create-error" className="max-w-md">
            <AlertCircle />
            <AlertTitle>Could not create a terminal session.</AlertTitle>
            <AlertDescription>
              Retry creation; no clipboard or terminal contents were logged.
            </AlertDescription>
          </Alert>
        ) : null}
        {canCreateSession && !isGitSource ? (
          <Button
            type="button"
            onClick={() => void handleCreateSession()}
            disabled={creating}
            data-testid="create-empty-session-button"
          >
            <Plus className="size-4" />
            {creating ? "Creating…" : "Create session"}
          </Button>
        ) : null}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          tabs={commandPaletteTabs}
          onSelectTab={handlePaletteSelect}
          onCreateSession={() => void handleCreateSession()}
          searchPlaceholder="Search workspace sessions…"
          emptyText="No workspace sessions found."
          groupHeading="Workspace sessions"
        />
      </div>
    );
  }

  return (
    <section
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
      data-testid="multi-session-workspace"
      data-session-source={source}
      aria-label={
        source === "git" ? "Workspace terminal sessions" : "Multi-session terminal workspace"
      }
      onKeyDown={handleWorkspaceKeyDown}
    >
      <header className="shrink-0 flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Active pane</p>
          <p className="truncate font-mono text-xs" data-testid="active-pane-label">
            {activeLabel ?? "No active pane"}
          </p>
        </div>
        <span className="sr-only" data-testid="multi-session-pane-count">
          {sessions.length}
        </span>
        {renderGitFontControls()}
        {renderGitRepositoryButton()}
        {renderGitRepositorySearchModal()}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          tabs={commandPaletteTabs}
          onSelectTab={handlePaletteSelect}
          onCreateSession={() => void handleCreateSession()}
          searchPlaceholder="Search workspace sessions…"
          emptyText="No workspace sessions found."
          groupHeading="Workspace sessions"
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleResetLayout}
          className="h-7 min-h-0 px-2 text-xs"
          aria-label="Reset layout"
          data-testid="reset-layout"
        >
          Reset
        </Button>
        {canCreateSession && !isGitSource ? (
          <Button
            type="button"
            size="xs"
            onClick={() => void handleCreateSession()}
            disabled={creating}
            className="h-7 min-h-0 px-2 text-xs"
            data-testid="create-session-button"
          >
            <Plus className="size-3" />
            {creating ? "Creating…" : "New"}
          </Button>
        ) : null}
      </header>

      {createFailed ? (
        <Alert variant="destructive" data-testid="session-create-error" className="m-3 mb-0">
          <AlertCircle />
          <AlertTitle>Could not create a terminal session.</AlertTitle>
          <AlertDescription>
            Existing panes remain mounted and selected state is unchanged.
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

      <div
        ref={workspaceBodyRef}
        className="relative min-h-0 flex-1 overflow-hidden p-2"
        data-testid="multi-session-body"
      >
        <div
          className="grid h-full min-h-0 gap-2"
          style={{
            gridTemplateColumns: layout.tiled.gridTemplateColumns,
            gridTemplateRows: layout.tiled.gridTemplateRows,
          }}
          data-testid="multi-session-grid"
        >
          {layout.panes.map(renderPane)}
        </div>
      </div>
    </section>
  );
}
