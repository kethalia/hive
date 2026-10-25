"use client";

import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { Terminal } from "@xterm/xterm";
import { Bot, Ellipsis, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { GeneralWorkspaceMobileControls } from "@/components/workspaces/GeneralWorkspaceMobileControls";
import { GeneralWorkspacePane } from "@/components/workspaces/GeneralWorkspacePane";
import { GeneralWorkspacePicker } from "@/components/workspaces/GeneralWorkspacePicker";
import { WorkspaceBoardBar } from "@/components/workspaces/WorkspaceBoardBar";
import { WorkspaceWindow } from "@/components/workspaces/WorkspaceWindow";
import { useIsMobile } from "@/hooks/use-mobile";
import { useKeybindings, useRegisterKeybinding } from "@/hooks/useKeybindings";
import { listWorkspacesAction, startWorkspaceAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import { forgetTerminalViews, terminalPaneViewKey } from "@/lib/terminal/session-lifetime";
import {
  addGeneralWindow,
  emptyGeneralWorkspace,
  GENERAL_WORKSPACE_OPEN_EVENT,
  type GeneralPane,
  type GeneralWorkspaceState,
  type GeneralWorkspaceTool,
  generalToolSchema,
  generalWorkspaceStorageKey,
  importLegacyWorkspaceBoards,
  MAX_GENERAL_BOARDS,
  MAX_GENERAL_WINDOWS,
  parseGeneralWorkspace,
} from "@/lib/workspaces/general-workspace";
import {
  computeWorkspaceWindowRects,
  moveWorkspaceWindow,
  reconcileWorkspaceWindowLayout,
  workspaceWindowDropPosition,
} from "@/lib/workspaces/workspace-window-layout";

const WorkspaceListContent = dynamic(() =>
  import("@/app/(dashboard)/workspaces/workspace-list-content").then((m) => m.WorkspaceListContent),
);
const AgentToolsDialog = dynamic(() =>
  import("./AgentToolsDialog").then((m) => m.AgentToolsDialog),
);
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
  const [state, setState] = useState<GeneralWorkspaceState>(emptyGeneralWorkspace);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loaded, setLoaded] = useState(false);
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const initialWorkspacesRef = useRef(initialWorkspaces);
  initialWorkspacesRef.current = initialWorkspaces;
  const [notice, setNotice] = useState<string | null>(error ?? null);
  const [picker, setPicker] = useState<{ workspaceId?: string } | null>(null);
  const [manage, setManage] = useState(false);
  const [launch, setLaunch] = useState(false);
  const [agents, setAgents] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const body = useRef<HTMLDivElement>(null);
  const entries = useRef(
    new Map<string, { term: Terminal; send: (data: string) => void; sessionName: string }>(),
  );
  const { setActiveTerminal } = useKeybindings();
  const storageKey = generalWorkspaceStorageKey(userId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
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
  useEffect(() => {
    setWorkspaces(initialWorkspaces);
  }, [initialWorkspaces]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listWorkspacesAction()
        .then((result) => {
          if (!cancelled && result?.data) setWorkspaces(result.data);
        })
        .catch(() => {});
    };
    const timer = setInterval(refresh, 15000);
    window.addEventListener("hive:sidebar-refresh", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("hive:sidebar-refresh", refresh);
    };
  }, []);
  useEffect(() => {
    if (!loaded || !body.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width && entry.contentRect.height)
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(body.current);
    return () => observer.disconnect();
  }, [loaded]);
  const update = useCallback(
    (change: (current: GeneralWorkspaceState) => GeneralWorkspaceState) => {
      const changed = change(stateRef.current);
      const next = {
        ...changed,
        boards: changed.boards.map((b) => ({
          ...b,
          layout:
            reconcileWorkspaceWindowLayout(
              b.layout,
              b.windows.map((w) => w.id),
              {
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                focusedWindowId: b.activeWindowId,
              },
            ) ?? undefined,
        })),
      };
      stateRef.current = next;
      setState(next);
      setVisited((current) => new Set([...current, next.activeBoardKey]));
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        setNotice("Layout storage is unavailable. Changes will last until you leave this page.");
      }
    },
    [storageKey, viewport.width, viewport.height],
  );
  function activate(boardKey: string, id: string) {
    update((current) => ({
      ...current,
      activeBoardKey: boardKey,
      boards: current.boards.map((b) => (b.key === boardKey ? { ...b, activeWindowId: id } : b)),
    }));
    const entry = entries.current.get(terminalPaneViewKey(boardKey, id));
    setActiveTerminal(entry?.term ?? null, entry?.send ?? null);
  }
  const openPane = useCallback(
    (pane: GeneralPane) => {
      update((current) => {
        const next = addGeneralWindow(current, pane, crypto.randomUUID());
        if (next === current)
          setNotice(`The workspace supports up to ${MAX_GENERAL_WINDOWS} open windows.`);
        return next;
      });
      setPicker(null);
    },
    [update],
  );
  const openTool = useCallback(
    (workspaceId: string, tool: GeneralWorkspaceTool) => {
      if (tool === "terminal") {
        setPicker({ workspaceId });
        return;
      }
      openPane({ kind: "app", workspaceId, tool, label: labels[tool] });
    },
    [openPane],
  );
  const requestOpen = useCallback(
    (workspaceId: string, tool?: GeneralWorkspaceTool) => {
      setManage(false);
      if (tool && tool !== "terminal") openTool(workspaceId, tool);
      else setPicker({ workspaceId });
    },
    [openTool],
  );
  const request = search.toString();
  const consumed = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || !request || consumed.current === request) return;
    consumed.current = request;
    const query = new URLSearchParams(request);
    const workspaceId = query.get("workspace");
    const tool = generalToolSchema.safeParse(query.get("tool"));
    if (workspaceId) requestOpen(workspaceId, tool.success ? tool.data : undefined);
    if (query.get("launch") === "1") {
      setLaunch(true);
      setManage(true);
    }
    router.replace("/workspaces", { scroll: false });
  }, [loaded, request, requestOpen, router]);
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
    const entry = active
      ? entries.current.get(terminalPaneViewKey(board.key, active.id))
      : undefined;
    setActiveTerminal(entry?.term ?? null, entry?.send ?? null);
  }, [active, board.key, setActiveTerminal]);
  useEffect(() => () => setActiveTerminal(null, null), [setActiveTerminal]);
  const start = useCallback(async (workspaceId: string) => {
    const result = await startWorkspaceAction({ workspaceId });
    if (!result?.data) throw new Error(result?.serverError ?? "Could not start workspace.");
    const refreshed = await listWorkspacesAction();
    if (refreshed?.data) setWorkspaces(refreshed.data);
    window.dispatchEvent(new Event("hive:sidebar-refresh"));
  }, []);
  function closeWindow(boardKey: string, id: string) {
    const target = stateRef.current.boards
      .find((b) => b.key === boardKey)
      ?.windows.find((w) => w.id === id);
    if (target) forgetTerminalViews(target.workspaceId, [terminalPaneViewKey(boardKey, id)]);
    update((current) => ({
      ...current,
      boards: current.boards.map((b) =>
        b.key === boardKey
          ? {
              ...b,
              windows: b.windows.filter((w) => w.id !== id),
              activeWindowId:
                b.activeWindowId === id ? b.windows.find((w) => w.id !== id)?.id : b.activeWindowId,
            }
          : b,
      ),
    }));
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
        { key, name: String(current.boards.length + 1), order: current.boards.length, windows: [] },
      ],
    }));
  }
  function deleteBoard(key: string) {
    if (stateRef.current.boards.length <= 1) return;
    const removed = stateRef.current.boards.find((b) => b.key === key);
    for (const pane of removed?.windows ?? [])
      forgetTerminalViews(pane.workspaceId, [terminalPaneViewKey(key, pane.id)]);
    update((current) => {
      const boards = current.boards.filter((b) => b.key !== key);
      return {
        ...current,
        boards,
        activeBoardKey: current.activeBoardKey === key ? boards[0].key : current.activeBoardKey,
      };
    });
  }
  function drop(event: DragEndEvent) {
    setDragging(false);
    const over = event.over;
    if (!over || event.active.id === over.id) return;
    update((current) => ({
      ...current,
      boards: current.boards.map((b) => {
        if (b.key !== current.activeBoardKey) return b;
        const root = reconcileWorkspaceWindowLayout(
          b.layout,
          b.windows.map((w) => w.id),
          {
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            focusedWindowId: b.activeWindowId,
          },
        );
        if (!root) return b;
        const rect = over.rect;
        const moved = event.active.rect.current.translated;
        const position = workspaceWindowDropPosition(
          { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          {
            x: moved ? moved.left + moved.width / 2 : rect.left,
            y: moved ? moved.top + moved.height / 2 : rect.top,
          },
        );
        return {
          ...b,
          layout: moveWorkspaceWindow(root, String(event.active.id), String(over.id), position),
        };
      }),
    }));
  }
  useRegisterKeybinding({
    id: "general-workspace:add-window",
    keys: ["ctrl+shift+n", "cmd+shift+n"],
    action: () => {
      setPicker({});
      return false;
    },
    description: "Add workspace window",
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
  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-dashboard-full-bleed=""
      data-testid="general-workspace"
    >
      <header className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-2 py-2">
        <SidebarTrigger />
        <WorkspaceBoardBar
          boards={state.boards.map((b) => ({ ...b, panes: [] }))}
          activeBoardKey={board.key}
          onCreate={createBoard}
          onDelete={deleteBoard}
          onSelect={(key) => update((current) => ({ ...current, activeBoardKey: key }))}
          className="justify-self-center"
          touchOptimized={mobile}
        />
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label="Agent tools"
            onClick={() => (active ? setAgents(active.workspaceId) : setPicker({}))}
          >
            <Bot className="size-4" />
            <span className="hidden sm:inline">Agents</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPicker({})}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">Add window</span>
            <span className="sr-only sm:hidden">Add window</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Manage Coder workspaces"
            onClick={() => {
              setLaunch(false);
              setManage(true);
            }}
          >
            <Ellipsis />
          </Button>
        </div>
      </header>
      {notice ? (
        <div role="alert" className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
          <span>{notice}</span>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {mobile && board.windows.length > 1 ? (
        <nav className="flex shrink-0 gap-1 overflow-x-auto p-1" aria-label="Open windows">
          {board.windows.map((pane) => (
            <Button
              key={pane.id}
              variant={pane.id === board.activeWindowId ? "secondary" : "ghost"}
              onClick={() => activate(board.key, pane.id)}
              className="shrink-0"
            >
              {workspaces.find((w) => w.id === pane.workspaceId)?.name} · {pane.label}
            </Button>
          ))}
        </nav>
      ) : null}
      <div
        ref={body}
        className={`relative min-h-0 flex-1 ${dragging ? "[&_iframe]:pointer-events-none" : ""}`}
      >
        {!board.windows.length ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <h1 className="text-lg">Your workspace</h1>
            <p className="text-sm text-muted-foreground">
              Bring terminals, Files, VS Code, and Desktop together from any Coder workspace.
            </p>
            <Button onClick={() => setPicker({})}>Add window</Button>
          </div>
        ) : null}
        {state.boards
          .filter((b) => visited.has(b.key) || b.key === board.key)
          .map((b) => {
            const root = reconcileWorkspaceWindowLayout(
              b.layout,
              b.windows.map((w) => w.id),
              {
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                focusedWindowId: b.activeWindowId,
              },
            );
            const rects = computeWorkspaceWindowRects(root);
            const visible = b.key === board.key;
            return (
              <div
                key={b.key}
                className="absolute inset-0"
                style={{ display: visible ? "block" : "none" }}
                aria-hidden={!visible}
              >
                <DndContext
                  sensors={sensors}
                  onDragStart={() => setDragging(true)}
                  onDragCancel={() => setDragging(false)}
                  onDragEnd={drop}
                >
                  {b.windows.map((pane) => {
                    const rect = rects.get(pane.id);
                    const focused = pane.id === (b.activeWindowId ?? b.windows[0]?.id);
                    const viewKey = terminalPaneViewKey(b.key, pane.id);
                    return (
                      <WorkspaceWindow
                        key={pane.id}
                        id={pane.id}
                        style={
                          mobile
                            ? { inset: 0, display: focused ? "block" : "none" }
                            : {
                                left: `${(rect?.x ?? 0) * 100}%`,
                                top: `${(rect?.y ?? 0) * 100}%`,
                                width: `${(rect?.width ?? 1) * 100}%`,
                                height: `${(rect?.height ?? 1) * 100}%`,
                              }
                        }
                      >
                        {({ dragHandleListeners }) => (
                          <GeneralWorkspacePane
                            pane={pane}
                            workspace={workspaces.find((w) => w.id === pane.workspaceId)}
                            boardKey={b.key}
                            active={focused}
                            visible={visible && (!mobile || focused)}
                            mobile={mobile}
                            layoutSignal={JSON.stringify(rect)}
                            dragHandleListeners={mobile ? undefined : dragHandleListeners}
                            onActivate={() => activate(b.key, pane.id)}
                            onClose={() => closeWindow(b.key, pane.id)}
                            onOpenTool={(tool) => openTool(pane.workspaceId, tool)}
                            onStart={() => {
                              void start(pane.workspaceId).catch((err) => setNotice(err.message));
                            }}
                            onReady={(term, send, sessionName) => {
                              entries.current.set(viewKey, { term, send, sessionName });
                              if (
                                stateRef.current.activeBoardKey === b.key &&
                                stateRef.current.boards.find((board) => board.key === b.key)
                                  ?.activeWindowId === pane.id
                              )
                                setActiveTerminal(term, send);
                            }}
                            onDestroy={() => {
                              entries.current.delete(viewKey);
                              if (
                                stateRef.current.activeBoardKey === b.key &&
                                stateRef.current.boards.find((board) => board.key === b.key)
                                  ?.activeWindowId === pane.id
                              )
                                setActiveTerminal(null, null);
                            }}
                          />
                        )}
                      </WorkspaceWindow>
                    );
                  })}
                </DndContext>
              </div>
            );
          })}
      </div>
      {mobile && active?.kind === "terminal" ? (
        <GeneralWorkspaceMobileControls
          workspaceId={active.workspaceId}
          sessionName={
            entries.current.get(terminalPaneViewKey(board.key, active.id))?.sessionName ??
            active.sessionName
          }
        />
      ) : null}
      <GeneralWorkspacePicker
        open={picker !== null}
        workspaceId={picker?.workspaceId}
        workspaces={workspaces}
        onOpenChange={(open) => {
          if (!open) setPicker(null);
        }}
        onOpenPane={openPane}
        onOpenTool={openTool}
        onStart={start}
        onAgents={(workspaceId) => {
          setPicker(null);
          setAgents(workspaceId);
        }}
      />
      {agents ? (
        <AgentToolsDialog
          workspaceId={agents}
          open
          onOpenChange={(open) => {
            if (!open) setAgents(null);
          }}
          onOpenSession={(sessionName) => {
            const existing = state.boards
              .flatMap((b) => b.windows)
              .find(
                (pane) =>
                  pane.workspaceId === agents &&
                  pane.kind === "terminal" &&
                  pane.sessionName === sessionName,
              );
            if (existing) openPane(existing);
            else if (sessionName.startsWith("git-clone-")) setPicker({ workspaceId: agents });
            else
              openPane({ kind: "terminal", workspaceId: agents, sessionName, label: sessionName });
            setAgents(null);
          }}
        />
      ) : null}
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-[90vw]">
          <DialogHeader>
            <DialogTitle>Coder workspaces</DialogTitle>
            <DialogDescription>
              Launch and manage the environments behind your windows.
            </DialogDescription>
          </DialogHeader>
          <WorkspaceListContent workspaces={workspaces} launchOnMount={launch} />
        </DialogContent>
      </Dialog>
    </section>
  );
}
