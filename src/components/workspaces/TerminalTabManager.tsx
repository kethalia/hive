"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createSessionAction } from "@/lib/actions/workspaces";
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

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex items-center border-b border-border bg-background px-1">
        <div className="flex items-center gap-0.5 overflow-x-auto py-1">
          {tabs.map((tab) => (
            <div key={tab.id} className="flex items-center">
              <Button
                variant={activeTabId === tab.id ? "outline" : "ghost"}
                size="sm"
                className="gap-1.5 font-mono text-xs"
                onClick={() => {
                  setActiveTabId(tab.id);
                  console.log(`[terminal-tabs] Switched to tab "${tab.sessionName}"`);
                }}
              >
                {tab.sessionName}
                {tabs.length > 1 && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="ml-1 rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
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
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-1 shrink-0"
          onClick={handleCreateTab}
          disabled={creating}
          title="New terminal tab"
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
              coderUrl={coderUrl}
              className="h-full"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
