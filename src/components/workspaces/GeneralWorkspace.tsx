"use client";

import type { Terminal } from "@xterm/xterm";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MobileTerminalShell } from "@/components/terminal/MobileTerminalShell";
import { Button } from "@/components/ui/button";
import { GeneralWorkspaceMobileControls } from "@/components/workspaces/GeneralWorkspaceMobileControls";
import { GeneralWorkspacePane } from "@/components/workspaces/GeneralWorkspacePane";
import { WorkspaceBoardBar } from "@/components/workspaces/WorkspaceBoardBar";
import { WorkspaceSearchButton } from "@/components/workspaces/WorkspaceHeaderButton";
import { useIsMobile } from "@/hooks/use-mobile";
import { useGeneralWorkspaceCommands } from "@/hooks/useGeneralWorkspaceCommands";
import { useKeybindings, useRegisterKeybinding } from "@/hooks/useKeybindings";
import { useVisualViewportKeyboardOffset } from "@/hooks/useVisualViewportKeyboardOffset";
import { useWindowManagerCommands } from "@/hooks/useWindowManagerCommands";
import { useWorkspaceNotifications } from "@/hooks/useWorkspaceNotifications";
import { startWorkspaceAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import { useDiscovery } from "@/lib/discovery/queries";
import { MANAGE_WORKSPACES_KEYS, WORKSPACE_AGENTS_KEYS } from "@/lib/keyboard-shortcuts";
import { openGlobalCommandPalette } from "@/lib/terminal/global-command-palette";
import { forgetTerminalViews, terminalPaneViewKey } from "@/lib/terminal/session-lifetime";
import type { GeneralBoard } from "@/lib/workspaces/general-workspace";
import {
  addGeneralFileWindow,
  addGeneralWindow,
  emptyGeneralWorkspace,
  GENERAL_WORKSPACE_OPEN_EVENT,
  type GeneralPane,
  type GeneralWorkspaceState,
  type GeneralWorkspaceTool,
  generalPaneIdentity,
  generalToolSchema,
  generalWorkspaceStorageKey,
  HIVE_WINDOW_OPEN_EVENT,
  type HiveWindowRequest,
  hiveToolSchema,
  hiveWindowRequestSchema,
  importLegacyWorkspaceBoards,
  MAX_GENERAL_BOARDS,
  MAX_GENERAL_WINDOWS,
  moveGeneralWindowToAdjacentBoard,
  openHiveWindow,
  parseGeneralWorkspace,
  removeGeneralWindow,
} from "@/lib/workspaces/general-workspace";
import { applyWindowAction } from "@/lib/workspaces/window-actions";
import { focusWorkspaceWindow } from "@/lib/workspaces/window-focus";
import {
  newWindowManager,
  reconcileWindowManager,
  revealWindow,
  type WindowManager,
  windowGeometry,
} from "@/lib/workspaces/window-manager";
import { reconcileWorkspaceWindowLayout } from "@/lib/workspaces/workspace-window-layout";
import { HiveWorkspacePane } from "./HiveWorkspacePane";
import { WindowCanvas } from "./WindowCanvas";
import { WindowLayoutControls } from "./WindowLayoutControls";
import { WindowShortcutHelp } from "./WindowShortcutHelp";

const labels = { files: "Files", code: "VS Code", desktop: "Desktop" };
interface Props {
  userId: string;
  initialWorkspaces: CoderWorkspace[];
  error?: string | null;
}
export function GeneralWorkspace({ userId, initialWorkspaces, error }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const mobile = useIsMobile();
  const { isKeyboardVisible } = useVisualViewportKeyboardOffset();
  const [state, setState] = useState<GeneralWorkspaceState>(emptyGeneralWorkspace);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loaded, setLoaded] = useState(false);
  const workspaceQuery = useDiscovery("workspaces", {}, { initialData: initialWorkspaces });
  const workspaces = workspaceQuery.data ?? [];
  const initialWorkspacesRef = useRef(initialWorkspaces);
  initialWorkspacesRef.current = initialWorkspaces;
  const [notice, setNotice] = useState<string | null>(error ?? null);
  const [launchRequest, setLaunchRequest] = useState(0);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const observeBody = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width && entry.contentRect.height)
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const entries = useRef(
    new Map<string, { term: Terminal; send: (data: string) => void; sessionName: string }>(),
  );
  const { setActiveTerminal } = useKeybindings();
  const storageKey = generalWorkspaceStorageKey(userId);
  const board = state.boards.find((b) => b.key === state.activeBoardKey) ?? state.boards[0];
  const active = board.windows.find((w) => w.id === board.activeWindowId);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const restored =
        parseGeneralWorkspace(raw) ??
        (raw
          ? emptyGeneralWorkspace()
          : importLegacyWorkspaceBoards(
              initialWorkspacesRef.current.map((w) => w.id),
              (key) => localStorage.getItem(key),
            ));
      stateRef.current = restored;
      setState(restored);
      setVisited(new Set([restored.activeBoardKey]));
      if (raw && !parseGeneralWorkspace(raw))
        setNotice(
          "The saved layout could not be restored. Existing Coder sessions are still available through Add window.",
        );
    } catch {
      setNotice("Layout storage is unavailable. Windows will work until you leave this page.");
    }
    setLoaded(true);
  }, [storageKey]);
  const update = useCallback(
    (
      change: (current: GeneralWorkspaceState) => GeneralWorkspaceState,
      { revealActiveWindow = false }: { revealActiveWindow?: boolean } = {},
    ) => {
      const changed = change(stateRef.current);
      const next = {
        ...changed,
        boards: changed.boards.map((b) => {
          const previous = stateRef.current.boards.find((old) => old.key === b.key);
          const ids = b.windows.map((w) => w.id);
          let manager = reconcileWindowManager(b.manager, ids, previous?.activeWindowId);
          const layout =
            reconcileWorkspaceWindowLayout(
              b.layout,
              ids.filter((id) => !manager.floating[id]),
              {
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                focusedWindowId: b.activeWindowId,
              },
            ) ?? undefined;
          // Reveal after reconciliation so a new pane already has a rectangle.
          // Reopening the same pane is explicit; ordinary scrolling/resizing must
          // not snap back to the active window on every state update.
          if (
            b.activeWindowId &&
            (b.activeWindowId !== previous?.activeWindowId ||
              (revealActiveWindow && b.key === changed.activeBoardKey))
          )
            manager = revealWindow(
              manager,
              windowGeometry(
                manager,
                layout,
                ids,
                b.activeWindowId,
                viewport.width,
                viewport.height,
              ),
              b.activeWindowId,
              viewport.width,
            );
          return { ...b, manager, layout };
        }),
      };
      stateRef.current = next;
      setState(next);
      setVisited((current) => new Set([...current, next.activeBoardKey]));
      return next;
    },
    [viewport.width, viewport.height],
  );
  useEffect(() => {
    if (!loaded) return;
    const save = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        setNotice("Layout storage is unavailable. Changes will last until you leave this page.");
      }
    };
    const timer = window.setTimeout(save, 120);
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", save);
    };
  }, [state, storageKey, loaded]);
  // Flush the most recent layout on a client-side route change as well as pagehide.
  useEffect(() => {
    if (!loaded) return;
    return () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(stateRef.current));
      } catch {
        /* Storage notice is handled while mounted. */
      }
    };
  }, [loaded, storageKey]);
  function changeBoard(key: string, change: (b: GeneralBoard) => GeneralBoard) {
    update((current) => ({
      ...current,
      boards: current.boards.map((b) => (b.key === key ? change(b) : b)),
    }));
  }
  function activate(boardKey: string, id: string) {
    update((current) => ({
      ...current,
      activeBoardKey: boardKey,
      boards: current.boards.map((b) => {
        if (b.key !== boardKey) return b;
        const manager = reconcileWindowManager(
          b.manager,
          b.windows.map((w) => w.id),
        );
        return {
          ...b,
          activeWindowId: id,
          manager: revealWindow(
            manager,
            windowGeometry(
              manager,
              b.layout,
              b.windows.map((w) => w.id),
              id,
              viewport.width,
              viewport.height,
            ),
            id,
            viewport.width,
          ),
        };
      }),
    }));
    const entry = entries.current.get(terminalPaneViewKey("general", id));
    setActiveTerminal(entry?.term ?? null, entry?.send ?? null);
  }
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (!focusRequest) return;
    const frame = requestAnimationFrame(focusWorkspaceWindow);
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  const openPane = useCallback(
    (pane: GeneralPane) => {
      setFocusRequest((value) => value + 1);
      update(
        (current) => {
          const existingBoard = current.boards.find((b) =>
            b.windows.some((w) => generalPaneIdentity(w) === generalPaneIdentity(pane)),
          );
          const next =
            pane.kind === "hive"
              ? openHiveWindow(current, pane, crypto.randomUUID())
              : addGeneralWindow(current, pane, crypto.randomUUID(), existingBoard?.key);
          if (next === current)
            setNotice(`The workspace supports up to ${MAX_GENERAL_WINDOWS} open windows.`);
          return next;
        },
        { revealActiveWindow: true },
      );
    },
    [update],
  );
  const openHiveTool = useCallback(
    (request: HiveWindowRequest) => {
      setFocusRequest((value) => value + 1);
      update(
        (current) => {
          const next = openHiveWindow(current, request, crypto.randomUUID());
          if (next === current)
            setNotice(`The workspace supports up to ${MAX_GENERAL_WINDOWS} open windows.`);
          return next;
        },
        { revealActiveWindow: true },
      );
      if (request.tool === "workspaces" && request.launch) setLaunchRequest((value) => value + 1);
    },
    [update],
  );
  const openAgents = useCallback(
    (workspaceId?: string) => openHiveTool({ tool: "agents", workspaceId }),
    [openHiveTool],
  );
  const openTool = useCallback(
    (workspaceId: string, tool: GeneralWorkspaceTool) => {
      if (tool === "terminal") {
        openGlobalCommandPalette();
        return;
      }
      openPane({ kind: "app", workspaceId, tool, label: labels[tool] });
    },
    [openPane],
  );
  const requestOpen = useCallback(
    (workspaceId: string, tool?: GeneralWorkspaceTool) => {
      if (tool && tool !== "terminal") openTool(workspaceId, tool);
      else openGlobalCommandPalette();
    },
    [openTool],
  );
  const notification = useWorkspaceNotifications({
    loaded,
    state,
    update,
    onError: setNotice,
    onFocus: (key, id) => {
      activate(key, id);
      entries.current.get(terminalPaneViewKey("general", id))?.term.focus();
    },
  });
  const request = search.toString();
  const consumed = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || !request || consumed.current === request) return;
    consumed.current = request;
    const query = new URLSearchParams(request);
    const workspaceId = query.get("workspace");
    const tool = generalToolSchema.safeParse(query.get("tool"));
    const sessionName = query.get("session");
    const panel = hiveToolSchema.safeParse(query.get("panel"));
    if (panel.success)
      openHiveTool({
        tool: panel.data,
        sessionName: panel.data === "logs" ? (sessionName ?? undefined) : undefined,
        template: query.get("template") ?? undefined,
        workspaceId: workspaceId ?? undefined,
        launch: query.get("launch") === "1",
      });
    else if (workspaceId && sessionName) void notification.open(workspaceId, sessionName);
    else if (workspaceId) requestOpen(workspaceId, tool.success ? tool.data : undefined);
    if (!panel.success && (query.get("launch") === "1" || query.get("manage") === "1"))
      openHiveTool({ tool: "workspaces", launch: query.get("launch") === "1" });
    router.replace("/workspaces", { scroll: false });
  }, [loaded, request, requestOpen, router, notification.open, openHiveTool]);
  useEffect(() => {
    if (!request) consumed.current = null;
  }, [request]);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: unknown; tool?: unknown }>).detail;
      if (typeof detail?.workspaceId !== "string") return;
      const tool = generalToolSchema.safeParse(detail.tool);
      requestOpen(detail.workspaceId, tool.success ? tool.data : undefined);
    };
    window.addEventListener(GENERAL_WORKSPACE_OPEN_EVENT, handler);
    return () => window.removeEventListener(GENERAL_WORKSPACE_OPEN_EVENT, handler);
  }, [requestOpen]);
  useEffect(() => {
    const handler = (event: Event) => {
      const request = hiveWindowRequestSchema.safeParse((event as CustomEvent).detail);
      if (request.success) openHiveTool(request.data);
    };
    window.addEventListener(HIVE_WINDOW_OPEN_EVENT, handler);
    return () => window.removeEventListener(HIVE_WINDOW_OPEN_EVENT, handler);
  }, [openHiveTool]);
  useEffect(() => {
    const entry = active
      ? entries.current.get(terminalPaneViewKey("general", active.id))
      : undefined;
    setActiveTerminal(entry?.term ?? null, entry?.send ?? null);
  }, [active, setActiveTerminal]);
  useEffect(() => () => setActiveTerminal(null, null), [setActiveTerminal]);
  const start = useCallback(
    async (workspaceId: string) => {
      const result = await startWorkspaceAction({ workspaceId });
      if (!result?.data) throw new Error(result?.serverError ?? "Could not start workspace.");
      await workspaceQuery.refresh();
      window.dispatchEvent(new Event("hive:discovery-refresh"));
    },
    [workspaceQuery.refresh],
  );
  const manager = reconcileWindowManager(
    board.manager,
    board.windows.map((w) => w.id),
  );
  const windowActions = useWindowManagerCommands(manager, runWindowAction);
  const changeShortcuts = useCallback(
    (shortcuts: WindowManager["shortcuts"]) => {
      update((current) => ({
        ...current,
        boards: current.boards.map((b) =>
          b.key === current.activeBoardKey
            ? {
                ...b,
                manager: {
                  ...reconcileWindowManager(
                    b.manager,
                    b.windows.map((w) => w.id),
                  ),
                  shortcuts,
                },
              }
            : b,
        ),
      }));
    },
    [update],
  );
  useGeneralWorkspaceCommands({
    workspaces,
    onOpenPane: openPane,
    onError: setNotice,
    onStart: start,
    initialWorkspaceId: active?.workspaceId,
    additionalActions: windowActions,
  });
  function closeWindow(boardKey: string, id: string) {
    const board = stateRef.current.boards.find((b) => b.key === boardKey);
    const target = board?.windows.find((w) => w.id === id);
    const restoreFocus =
      boardKey === stateRef.current.activeBoardKey &&
      ((board?.activeWindowId ?? board?.windows[0]?.id) === id ||
        document.activeElement
          ?.closest("[data-workspace-window-id]")
          ?.getAttribute("data-workspace-window-id") === id);
    if (target?.kind === "hive" && target.tool === "workspaces") setLaunchRequest(0);
    if (target?.kind === "terminal")
      forgetTerminalViews(target.workspaceId, [terminalPaneViewKey("general", id)]);
    const next = update((current) => ({
      ...current,
      boards: current.boards.map((b) =>
        b.key === boardKey
          ? removeGeneralWindow(b, id, mobile ? b.windows.map((w) => w.id) : undefined)
          : b,
      ),
    }));
    if (restoreFocus) {
      const active = next.boards.find((b) => b.key === next.activeBoardKey)?.activeWindowId;
      const entry = active
        ? entries.current.get(terminalPaneViewKey("general", active))
        : undefined;
      setActiveTerminal(entry?.term ?? null, entry?.send ?? null);
      setFocusRequest((value) => value + 1);
    }
  }
  function createBoard() {
    if (stateRef.current.boards.length >= MAX_GENERAL_BOARDS) {
      setNotice(`You can create up to ${MAX_GENERAL_BOARDS} boards.`);
      return;
    }
    const key = crypto.randomUUID();
    update((current) => ({
      ...current,
      activeBoardKey: key,
      boards: [
        ...current.boards,
        {
          key,
          name: String(current.boards.length + 1),
          order: current.boards.length,
          windows: [],
          manager: newWindowManager(),
        },
      ],
    }));
  }
  function deleteBoard(key: string) {
    const removed = stateRef.current.boards.find((b) => b.key === key);
    if (!removed) return;
    if (removed.windows.some((pane) => pane.kind === "hive" && pane.tool === "workspaces"))
      setLaunchRequest(0);
    for (const pane of removed?.windows ?? [])
      if (pane.kind === "terminal")
        forgetTerminalViews(pane.workspaceId, [terminalPaneViewKey("general", pane.id)]);
    update((current) => {
      const boards = current.boards.filter((b) => b.key !== key);
      if (!boards.length) return emptyGeneralWorkspace();
      return {
        ...current,
        boards,
        activeBoardKey: current.activeBoardKey === key ? boards[0].key : current.activeBoardKey,
      };
    });
  }
  function runWindowAction(action: string) {
    if (action === "create-board") {
      createBoard();
      return;
    }
    if (action === "close-board") {
      deleteBoard(stateRef.current.activeBoardKey);
      return;
    }
    update((current) => {
      const index = current.boards.findIndex((b) => b.key === current.activeBoardKey);
      if (action.startsWith("board-")) {
        const target =
          action === "board-previous"
            ? (index - 1 + current.boards.length) % current.boards.length
            : action === "board-next"
              ? (index + 1) % current.boards.length
              : Number(action.slice(6)) - 1;
        return current.boards[target]
          ? { ...current, activeBoardKey: current.boards[target].key }
          : current;
      }
      if (action === "next-board" || action === "previous-board")
        return moveGeneralWindowToAdjacentBoard(
          current,
          crypto.randomUUID(),
          action === "previous-board" ? -1 : 1,
        );
      return {
        ...current,
        boards: current.boards.map((b) =>
          b.key === current.activeBoardKey
            ? applyWindowAction(b, action, viewport.width, viewport.height)
            : b,
        ),
      };
    });
    setFocusRequest((value) => value + 1);
  }
  useRegisterKeybinding({
    id: "general-workspace:agents",
    keys: [...WORKSPACE_AGENTS_KEYS],
    action: () => {
      openAgents(active?.workspaceId);
      return false;
    },
    description: "Open agent tools and sessions",
    category: "workspace",
    enabledInBrowser: true,
    global: true,
  });
  useRegisterKeybinding({
    id: "general-workspace:manage",
    keys: [...MANAGE_WORKSPACES_KEYS],
    action: () => {
      openHiveTool({ tool: "workspaces" });
      return false;
    },
    description: "Manage Coder workspaces",
    category: "workspace",
    enabledInBrowser: true,
    global: true,
  });

  if (!loaded)
    return (
      <p className="p-4" role="status">
        Restoring workspace…
      </p>
    );
  const content = (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-dashboard-full-bleed=""
      data-testid="general-workspace"
    >
      <WindowShortcutHelp shortcuts={manager.shortcuts} onChange={changeShortcuts} />
      <header className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-2 pb-2 pt-[calc(var(--safe-area-inset-top)+0.5rem)]">
        <WorkspaceSearchButton />
        <WorkspaceBoardBar
          boards={state.boards}
          activeBoardKey={board.key}
          onCreate={createBoard}
          onDelete={deleteBoard}
          onSelect={(key) => update((current) => ({ ...current, activeBoardKey: key }))}
          className="justify-self-center"
          touchOptimized={mobile}
        />
        <div className="flex items-center gap-1">
          {!mobile ? <WindowLayoutControls manager={manager} onAction={runWindowAction} /> : null}
        </div>
      </header>
      {notification.opening ? (
        <p role="status" className="px-3 py-2 text-sm">
          Opening notification window…
        </p>
      ) : null}
      {notice ? (
        <div role="alert" className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
          <span>{notice}</span>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {mobile && board.windows.length > 1 ? (
        <nav
          className="flex shrink-0 gap-1 overflow-x-auto p-1"
          aria-label="Open windows"
          data-mobile-scroll-allow="true"
        >
          {board.windows.map((pane) => (
            <Button
              key={pane.id}
              variant={pane.id === board.activeWindowId ? "secondary" : "ghost"}
              onClick={() => activate(board.key, pane.id)}
              className="shrink-0"
            >
              {pane.kind !== "hive"
                ? `${workspaces.find((w) => w.id === pane.workspaceId)?.name ?? "Workspace"} · `
                : ""}
              {pane.label}
            </Button>
          ))}
        </nav>
      ) : null}
      <div ref={observeBody} className="relative min-h-0 flex-1">
        {!board.windows.length ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <h1 className="text-lg">Your workspace</h1>
            <p className="text-sm text-muted-foreground">
              Bring terminals, Files, VS Code, and Desktop together from any Coder workspace.
            </p>
            <Button onClick={() => openGlobalCommandPalette()}>Add window</Button>
          </div>
        ) : null}
        <WindowCanvas
          boards={state.boards.filter((b) => visited.has(b.key) || b.key === board.key)}
          activeBoardKey={board.key}
          width={viewport.width}
          height={viewport.height}
          mobile={mobile}
          onBoardChange={changeBoard}
          onActivate={activate}
          renderPane={(b, pane, visible, rect, dragHandleListeners) => {
            if (pane.kind === "hive")
              return (
                <HiveWorkspacePane
                  pane={pane}
                  userId={userId}
                  workspaces={workspaces}
                  active={pane.id === b.activeWindowId}
                  visible={visible}
                  launchRequest={launchRequest}
                  dragHandleListeners={mobile ? undefined : dragHandleListeners}
                  onActivate={() => activate(b.key, pane.id)}
                  onClose={() => closeWindow(b.key, pane.id)}
                  onWorkspaceChange={(workspaceId) =>
                    changeBoard(b.key, (current) => ({
                      ...current,
                      windows: current.windows.map((w) =>
                        w.id === pane.id ? { ...w, workspaceId } : w,
                      ),
                    }))
                  }
                  onOpenSession={(workspaceId, sessionName) => {
                    const current = stateRef.current;
                    const existingBoard = current.boards.find((b) =>
                      b.windows.some(
                        (w) =>
                          w.kind === "terminal" &&
                          w.workspaceId === workspaceId &&
                          w.sessionName === sessionName,
                      ),
                    );
                    const existing = existingBoard?.windows.find(
                      (w) =>
                        w.kind === "terminal" &&
                        w.workspaceId === workspaceId &&
                        w.sessionName === sessionName,
                    );
                    if (existing) openPane(existing);
                    else if (sessionName.startsWith("git-clone-"))
                      void notification.open(workspaceId, sessionName);
                    else
                      openPane({ kind: "terminal", workspaceId, sessionName, label: sessionName });
                  }}
                />
              );
            const viewKey = terminalPaneViewKey("general", pane.id);
            return (
              <GeneralWorkspacePane
                pane={pane}
                workspace={workspaces.find((w) => w.id === pane.workspaceId)}
                boardKey="general"
                active={pane.id === (b.activeWindowId ?? b.windows[0]?.id)}
                visible={visible}
                mobile={mobile}
                layoutSignal={rect}
                dragHandleListeners={mobile ? undefined : dragHandleListeners}
                onActivate={() => activate(b.key, pane.id)}
                onClose={() => closeWindow(b.key, pane.id)}
                onOpenTool={(tool) => openTool(pane.workspaceId, tool)}
                onOpenFile={(file, newBoard) =>
                  update(
                    (current) => {
                      const next = addGeneralFileWindow(
                        current,
                        file,
                        b.key,
                        newBoard,
                        crypto.randomUUID(),
                      );
                      if (next === current)
                        setNotice(
                          "Could not open another window. Close an unused window or board first.",
                        );
                      return next;
                    },
                    { revealActiveWindow: true },
                  )
                }
                onStart={() => {
                  void start(pane.workspaceId).catch((err) => setNotice(err.message));
                }}
                onReady={(term, send, sessionName) => {
                  entries.current.set(viewKey, { term, send, sessionName });
                  if (
                    stateRef.current.activeBoardKey === b.key &&
                    stateRef.current.boards.find((board) => board.key === b.key)?.activeWindowId ===
                      pane.id
                  )
                    setActiveTerminal(term, send);
                }}
                onDestroy={() => {
                  entries.current.delete(viewKey);
                  if (
                    stateRef.current.activeBoardKey === b.key &&
                    stateRef.current.boards.find((board) => board.key === b.key)?.activeWindowId ===
                      pane.id
                  )
                    setActiveTerminal(null, null);
                }}
              />
            );
          }}
        />
      </div>
      {mobile && active?.kind === "terminal" ? (
        <GeneralWorkspaceMobileControls
          workspaceId={active.workspaceId}
          sessionName={
            entries.current.get(terminalPaneViewKey("general", active.id))?.sessionName ??
            active.sessionName
          }
        />
      ) : null}
    </section>
  );
  return mobile ? (
    <MobileTerminalShell
      isKeyboardVisible={isKeyboardVisible}
      reserveDashboardTrigger={false}
      stopKeyboardPropagation={false}
    >
      {content}
    </MobileTerminalShell>
  ) : (
    content
  );
}
