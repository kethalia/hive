"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createSessionAction,
  renameSessionAction,
  killSessionAction,
  getWorkspaceSessionsAction,
} from "@/lib/actions/workspaces";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
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
  workspaceId: string;
}

export function TerminalTabManager({
  agentId,
  workspaceId,
}: TerminalTabManagerProps) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

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
          setTabs(loaded);
          setActiveTabId(loaded[0].id);
        } else {
          const res = await createSessionAction({ workspaceId });
          if (cancelled) return;
          if (res?.data) {
            const tab: Tab = { id: crypto.randomUUID(), sessionName: res.data.name };
            setTabs([tab]);
            setActiveTabId(tab.id);
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
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
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
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId ? { ...t, sessionName: result.data.newName } : t,
            ),
          );
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
      <div className="flex items-center border-b border-border bg-background px-1">
        <div className="flex items-center gap-0.5 overflow-x-auto py-1">
          {tabs.map((tab) => (
            <div key={tab.id} className="group flex items-center">
              <Button
                variant={activeTabId === tab.id ? "outline" : "ghost"}
                size="sm"
                className="gap-1.5 font-mono text-xs"
                onClick={() => setActiveTabId(tab.id)}
                onDoubleClick={() => startRename(tab)}
              >
                {editingTabId === tab.id ? (
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
                ) : (
                  <span data-testid="tab-label">{tab.sessionName}</span>
                )}
                {tabs.length > 1 && (
                  <span
                    role="button"
                    tabIndex={0}
                    data-testid="close-tab"
                    title="Kill session"
                    className="ml-1 rounded p-0.5 opacity-0 hover:bg-destructive/20 hover:text-destructive group-hover:opacity-100"
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
              className="h-full"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
