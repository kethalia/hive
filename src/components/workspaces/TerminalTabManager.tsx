"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { X, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createSessionAction,
  renameSessionAction,
  killSessionAction,
  getWorkspaceSessionsAction,
} from "@/lib/actions/workspaces";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import type { TmuxSession } from "@/lib/workspaces/sessions";
import { cn } from "@/lib/utils";

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

interface TerminalTabManagerProps {
  agentId: string;
  coderUrl: string;
  workspaceId: string;
  initialSessions: TmuxSession[];
  initialSessionName?: string;
}

export function TerminalTabManager({
  agentId,
  coderUrl,
  workspaceId,
  initialSessions,
  initialSessionName,
}: TerminalTabManagerProps) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    if (initialSessionName) {
      return [{ id: crypto.randomUUID(), sessionName: initialSessionName }];
    }
    if (initialSessions.length > 0) {
      return [{ id: crypto.randomUUID(), sessionName: initialSessions[0].name }];
    }
    return [{ id: crypto.randomUUID(), sessionName: "hive-main" }];
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const [creating, setCreating] = useState(false);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [availableSessions, setAvailableSessions] = useState<TmuxSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingTabId]);

  useEffect(() => {
    if (!pickerOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pickerOpen]);

  const handleCreateTab = useCallback(async () => {
    setCreating(true);
    try {
      const result = await createSessionAction({ workspaceId });
      if (result?.data) {
        const newTab: Tab = {
          id: crypto.randomUUID(),
          sessionName: result.data.name,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        console.log(`[terminal-tabs] Created tab for session "${result.data.name}"`);
      }
    } catch (err) {
      console.error("[terminal-tabs] Failed to create session:", err);
    } finally {
      setCreating(false);
    }
  }, [workspaceId]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const updated = prev.filter((t) => t.id !== tabId);
        if (updated.length === 0) return prev;
        if (activeTabId === tabId) {
          const closedIndex = prev.findIndex((t) => t.id === tabId);
          const nextIndex = Math.min(closedIndex, updated.length - 1);
          setActiveTabId(updated[nextIndex].id);
        }
        console.log(`[terminal-tabs] Closed tab ${tabId}`);
        return updated;
      });
    },
    [activeTabId],
  );

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
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId ? { ...t, sessionName: result.data.newName } : t,
            ),
          );
          console.log(`[terminal-tabs] Renamed tab "${tab.sessionName}" → "${result.data.newName}"`);
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
        console.log(`[terminal-tabs] Killed session "${tab.sessionName}"`);

        setTabs((prev) => {
          const updated = prev.filter((t) => t.id !== tabId);
          if (updated.length > 0 && activeTabId === tabId) {
            const closedIndex = prev.findIndex((t) => t.id === tabId);
            const nextIndex = Math.min(closedIndex, updated.length - 1);
            setActiveTabId(updated[nextIndex].id);
          }
          return updated;
        });
      } catch (err) {
        console.error("[terminal-tabs] Failed to kill session:", err);
      }
    },
    [tabs, workspaceId, activeTabId],
  );

  const openPicker = useCallback(async () => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    setLoadingSessions(true);
    setPickerOpen(true);
    try {
      const result = await getWorkspaceSessionsAction({ workspaceId });
      if (result?.data) {
        setAvailableSessions(result.data);
      }
    } catch (err) {
      console.error("[terminal-tabs] Failed to fetch sessions:", err);
    } finally {
      setLoadingSessions(false);
    }
  }, [pickerOpen, workspaceId]);

  const openExistingSession = useCallback(
    (sessionName: string) => {
      const newTab: Tab = { id: crypto.randomUUID(), sessionName };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
      setPickerOpen(false);
      console.log(`[terminal-tabs] Opened existing session "${sessionName}"`);
    },
    [],
  );

  const openSessionNames = new Set(tabs.map((t) => t.sessionName));
  const unopenedSessions = availableSessions.filter(
    (s) => !openSessionNames.has(s.name),
  );

  const hasNoTabs = tabs.length === 0;

  if (hasNoTabs) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <p className="text-sm text-muted-foreground">No terminal sessions open</p>
        <Button onClick={handleCreateTab} disabled={creating}>
          <Plus className="mr-2 size-4" />
          Create New Session
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex items-center border-b border-border bg-background px-1">
        <div className="flex items-center gap-0.5 overflow-x-auto py-1">
          {tabs.map((tab) => (
            <div key={tab.id} className="group flex items-center">
              <Button
                variant={activeTabId === tab.id ? "outline" : "ghost"}
                size="sm"
                className="gap-1.5 font-mono text-xs"
                onClick={() => {
                  setActiveTabId(tab.id);
                  console.log(`[terminal-tabs] Switched to tab "${tab.sessionName}"`);
                }}
                onDoubleClick={() => startRename(tab)}
              >
                {editingTabId === tab.id ? (
                  <input
                    ref={editInputRef}
                    data-testid="rename-input"
                    className="w-24 bg-transparent font-mono text-xs outline-none"
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
                  />
                ) : (
                  <span data-testid="tab-label">{tab.sessionName}</span>
                )}
                <span className="ml-1 flex items-center gap-0.5">
                  <span
                    role="button"
                    tabIndex={0}
                    data-testid="kill-tab"
                    title="Kill session"
                    className="rounded p-0.5 opacity-0 hover:bg-destructive/20 hover:text-destructive group-hover:opacity-100"
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
                    <Trash2 className="size-3" />
                  </span>
                  {tabs.length > 1 && (
                    <span
                      role="button"
                      tabIndex={0}
                      data-testid="close-tab"
                      title="Close tab (keep session)"
                      className="rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseTab(tab.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          handleCloseTab(tab.id);
                        }
                      }}
                    >
                      <X className="size-3" />
                    </span>
                  )}
                </span>
              </Button>
            </div>
          ))}
        </div>
        <div className="relative ml-1 shrink-0" ref={pickerRef}>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={openPicker}
            disabled={creating}
            title="New terminal tab"
            data-testid="add-tab-button"
          >
            <Plus className="size-3.5" />
          </Button>
          {pickerOpen && (
            <div
              data-testid="session-picker"
              className="absolute left-0 top-full z-50 mt-1 min-w-48 rounded-md border border-border bg-background p-1 shadow-lg"
            >
              {loadingSessions ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading sessions...</div>
              ) : (
                <>
                  {unopenedSessions.map((session) => (
                    <button
                      key={session.name}
                      data-testid="session-picker-item"
                      className="flex w-full items-center rounded px-3 py-1.5 text-left font-mono text-xs hover:bg-accent"
                      onClick={() => openExistingSession(session.name)}
                    >
                      {session.name}
                    </button>
                  ))}
                  <button
                    data-testid="session-picker-create"
                    className="flex w-full items-center rounded px-3 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => {
                      setPickerOpen(false);
                      handleCreateTab();
                    }}
                  >
                    <Plus className="mr-1.5 size-3" />
                    Create New
                  </button>
                </>
              )}
            </div>
          )}
        </div>
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
              sessionName={tab.sessionName}
              coderUrl={coderUrl}
              className="h-full"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
