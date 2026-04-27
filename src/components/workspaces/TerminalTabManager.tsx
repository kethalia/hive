"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Terminal } from "@xterm/xterm";
import { X, Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  createSessionAction,
  renameSessionAction,
  killSessionAction,
  getWorkspaceSessionsAction,
} from "@/lib/actions/workspaces";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { connectionBadgeProps } from "@/components/workspaces/InteractiveTerminal";
import { KeepAliveWarning } from "@/components/workspaces/KeepAliveWarning";
import { useKeybindings } from "@/hooks/useKeybindings";
import { isPwaStandalone } from "@/lib/terminal/pwa";
import type { ConnectionState } from "@/hooks/useTerminalWebSocket";

const InteractiveTerminal = dynamic(
  () =>
    import("@/components/workspaces/InteractiveTerminal").then(
      (m) => m.InteractiveTerminal,
    ),
  { ssr: false },
);

interface Tab {
  id: string;
  sessionName: string;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
}

type TabAction =
  | { type: "SET_TABS"; tabs: Tab[]; activeTabId: string }
  | { type: "ADD_TAB"; tab: Tab }
  | { type: "RENAME_TAB"; tabId: string; newName: string }
  | { type: "KILL_TAB"; tabId: string }
  | { type: "SET_ACTIVE"; tabId: string };

function tabReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "SET_TABS":
      return { tabs: action.tabs, activeTabId: action.activeTabId };
    case "ADD_TAB":
      return { tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };
    case "RENAME_TAB":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId ? { ...t, sessionName: action.newName } : t,
        ),
      };
    case "KILL_TAB": {
      const updated = state.tabs.filter((t) => t.id !== action.tabId);
      let newActiveId = state.activeTabId;
      if (state.activeTabId === action.tabId) {
        if (updated.length > 0) {
          const closedIndex = state.tabs.findIndex((t) => t.id === action.tabId);
          const nextIndex = Math.min(closedIndex, updated.length - 1);
          newActiveId = updated[nextIndex].id;
        } else {
          newActiveId = null;
        }
      }
      return { tabs: updated, activeTabId: newActiveId };
    }
    case "SET_ACTIVE":
      return { ...state, activeTabId: action.tabId };
    default:
      return state;
  }
}

interface TerminalTabManagerProps {
  agentId: string;
  workspaceId: string;
}

export function TerminalTabManager({
  agentId,
  workspaceId,
}: TerminalTabManagerProps) {
  const [{ tabs, activeTabId }, dispatch] = useReducer(tabReducer, {
    tabs: [],
    activeTabId: null,
  });
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  const [connStates, setConnStates] = useState<Record<string, ConnectionState>>({});
  const keybindingsCtx = useKeybindings();
  const { setActiveTerminal } = keybindingsCtx;
  const terminalsRef = useRef<Map<string, { term: Terminal; send: (data: string) => void }>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const handleTerminalReady = useCallback((tabId: string, term: Terminal, send: (data: string) => void) => {
    terminalsRef.current.set(tabId, { term, send });
  }, []);

  const handleTerminalDestroy = useCallback((tabId: string) => {
    terminalsRef.current.delete(tabId);
  }, []);

  useEffect(() => {
    if (!activeTabId) {
      setActiveTerminal(null, null);
      return;
    }
    const entry = terminalsRef.current.get(activeTabId);
    if (entry) {
      setActiveTerminal(entry.term, entry.send);
    } else {
      setActiveTerminal(null, null);
    }
  }, [activeTabId, setActiveTerminal]);

  const handleConnectionStateChange = useCallback((tabId: string, state: ConnectionState) => {
    setConnStates((prev) => (prev[tabId] === state ? prev : { ...prev, [tabId]: state }));
  }, []);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const result = await getWorkspaceSessionsAction({ workspaceId });
        if (cancelled) return;

        if (result?.data && result.data.length > 0) {
          const loaded: Tab[] = result.data.map((s) => ({
            id: crypto.randomUUID(),
            sessionName: s.name,
          }));
          dispatch({ type: "SET_TABS", tabs: loaded, activeTabId: loaded[0].id });
        } else {
          const res = await createSessionAction({ workspaceId });
          if (cancelled) return;
          if (res?.data) {
            const tab: Tab = { id: crypto.randomUUID(), sessionName: res.data.name };
            dispatch({ type: "SET_TABS", tabs: [tab], activeTabId: tab.id });
            window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));
          }
        }
      } catch (err) {
        console.error("[terminal-tabs] Failed to load sessions:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [workspaceId]);

  const handleCreateTab = useCallback(async () => {
    setCreating(true);
    try {
      const result = await createSessionAction({ workspaceId });
      if (result?.data) {
        const newTab: Tab = {
          id: crypto.randomUUID(),
          sessionName: result.data.name,
        };
        dispatch({ type: "ADD_TAB", tab: newTab });
        window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));
      }
    } catch (err) {
      console.error("[terminal-tabs] Failed to create session:", err);
    } finally {
      setCreating(false);
    }
  }, [workspaceId]);

  const startRename = useCallback((tab: Tab) => {
    setEditingTabId(tab.id);
    setEditValue(tab.sessionName);
  }, []);

  const commitRename = useCallback(
    async (tabId: string) => {
      const trimmed = editValue.trim();
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) {
        setEditingTabId(null);
        return;
      }

      if (!trimmed || trimmed === tab.sessionName || !SAFE_IDENTIFIER_RE.test(trimmed)) {
        setEditingTabId(null);
        return;
      }

      try {
        const result = await renameSessionAction({
          workspaceId,
          oldName: tab.sessionName,
          newName: trimmed,
        });
        if (result?.data) {
          dispatch({ type: "RENAME_TAB", tabId, newName: result.data.newName });
        }
      } catch (err) {
        console.error("[terminal-tabs] Failed to rename session:", err);
      } finally {
        setEditingTabId(null);
      }
    },
    [editValue, tabs, workspaceId],
  );

  const cancelRename = useCallback(() => {
    setEditingTabId(null);
  }, []);

  const handleKillTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;

      try {
        await killSessionAction({ workspaceId, sessionName: tab.sessionName });
        window.localStorage.removeItem(`terminal:reconnect:${agentId}:${tab.sessionName}`);

        dispatch({ type: "KILL_TAB", tabId });
        window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));
      } catch (err) {
        console.error("[terminal-tabs] Failed to kill session:", err);
      }
    },
    [tabs, workspaceId, agentId],
  );

  useEffect(() => {
    const { register, unregister } = keybindingsCtx;

    const createTabBinding = {
      id: "session:create",
      keys: ["ctrl+t", "cmd+t"],
      action: () => {
        if (!isPwaStandalone()) return true;
        handleCreateTab();
        return false;
      },
      description: "Create new session tab",
      category: "session",
      enabledInBrowser: true,
    };

    const closeTabBinding = {
      id: "session:close",
      keys: ["ctrl+w", "cmd+w"],
      action: () => {
        if (!isPwaStandalone()) return true;
        if (tabsRef.current.length <= 1) return true;
        const currentActiveId = activeTabIdRef.current;
        if (currentActiveId) handleKillTab(currentActiveId);
        return false;
      },
      description: "Close active session tab",
      category: "session",
      enabledInBrowser: true,
    };

    const nextTabBinding = {
      id: "session:next-tab",
      keys: ["ctrl+tab"],
      action: () => {
        const currentTabs = tabsRef.current;
        const currentActiveId = activeTabIdRef.current;
        if (currentTabs.length <= 1) return false;
        const idx = currentTabs.findIndex((t) => t.id === currentActiveId);
        const nextIdx = (idx + 1) % currentTabs.length;
        dispatch({ type: "SET_ACTIVE", tabId: currentTabs[nextIdx].id });
        return false;
      },
      description: "Switch to next session tab",
      category: "session",
      enabledInBrowser: true,
    };

    const prevTabBinding = {
      id: "session:prev-tab",
      keys: ["ctrl+shift+tab"],
      action: () => {
        const currentTabs = tabsRef.current;
        const currentActiveId = activeTabIdRef.current;
        if (currentTabs.length <= 1) return false;
        const idx = currentTabs.findIndex((t) => t.id === currentActiveId);
        const prevIdx = (idx - 1 + currentTabs.length) % currentTabs.length;
        dispatch({ type: "SET_ACTIVE", tabId: currentTabs[prevIdx].id });
        return false;
      },
      description: "Switch to previous session tab",
      category: "session",
      enabledInBrowser: true,
    };

    register(createTabBinding);
    register(closeTabBinding);
    register(nextTabBinding);
    register(prevTabBinding);

    return () => {
      unregister("session:create");
      unregister("session:close");
      unregister("session:next-tab");
      unregister("session:prev-tab");
    };
  }, [keybindingsCtx, handleCreateTab, handleKillTab]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading sessions…</p>
      </div>
    );
  }

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background">
        <p className="text-sm text-muted-foreground">No terminal sessions open</p>
        <Button onClick={handleCreateTab} disabled={creating}>
          <Plus className="mr-2 size-4" />
          Create New Session
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <KeepAliveWarning workspaceId={workspaceId} />
      <div className="flex items-center border-b border-border bg-background px-1">
        <div className="flex items-center gap-0.5 overflow-x-auto py-1">
          {tabs.map((tab) => (
            <div key={tab.id} className="group flex items-center">
              {editingTabId === tab.id ? (
                <div className="flex items-center px-2 py-1">
                  <Input
                    data-testid="rename-input"
                    className="h-5 w-24 rounded border-none bg-transparent px-0 py-0 font-mono text-xs shadow-none focus-visible:ring-0"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitRename(tab.id);
                      } else if (e.key === "Escape") {
                        cancelRename();
                      }
                      e.stopPropagation();
                    }}
                    onBlur={() => commitRename(tab.id)}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                </div>
              ) : (
                <Button
                  variant={activeTabId === tab.id ? "outline" : "ghost"}
                  size="sm"
                  className="gap-1.5 font-mono text-xs"
                  onClick={() => dispatch({ type: "SET_ACTIVE", tabId: tab.id })}
                >
                  <span data-testid="tab-label">{tab.sessionName}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    data-testid="rename-tab"
                    aria-label={`Rename session ${tab.sessionName}`}
                    title="Rename session"
                    className="rounded p-0.5 hover:bg-accent-foreground/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(tab);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        startRename(tab);
                      }
                    }}
                  >
                    <Pencil className="size-3" />
                  </span>
                  {tabs.length > 1 && (
                    <span
                      role="button"
                      tabIndex={0}
                      data-testid="close-tab"
                      aria-label={`Kill session ${tab.sessionName}`}
                      title="Kill session"
                      className="rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleKillTab(tab.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          handleKillTab(tab.id);
                        }
                      }}
                    >
                      <X className="size-3" />
                    </span>
                  )}
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-1 shrink-0 px-1.5"
          onClick={handleCreateTab}
          disabled={creating}
          data-testid="add-tab-button"
        >
          <Plus className="size-3.5" />
        </Button>
        {activeTabId && connStates[activeTabId] && (() => {
          const badge = connectionBadgeProps(connStates[activeTabId]);
          return (
            <Badge variant={badge.variant} className={cn("ml-auto mr-2 text-[10px] px-1.5 py-0", badge.className)}>
              {badge.label}
            </Badge>
          );
        })()}
      </div>

      <div className="relative flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn("absolute inset-0", activeTabId !== tab.id && "pointer-events-none")}
            style={{ display: activeTabId === tab.id ? "block" : "none" }}
          >
            <InteractiveTerminal
              agentId={agentId}
              workspaceId={workspaceId}
              sessionName={tab.sessionName}
              className="h-full"
              onConnectionStateChange={(state) => handleConnectionStateChange(tab.id, state)}
              onTerminalReady={(term, send) => handleTerminalReady(tab.id, term, send)}
              onTerminalDestroy={() => handleTerminalDestroy(tab.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
