"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus, X, Loader2, Terminal, ChevronDown } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  getWorkspaceAction,
  getWorkspaceSessionsAction,
  createSessionAction,
  killSessionAction,
} from "@/lib/actions/workspaces";
import type { TmuxSession } from "@/lib/workspaces/sessions";
import { cn } from "@/lib/utils";

interface TerminalBreadcrumbsProps {
  workspaceId: string;
}

export function TerminalBreadcrumbs({ workspaceId }: TerminalBreadcrumbsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSession = searchParams.get("session");

  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    (async () => {
      try {
        const [wsResult, sessionsResult] = await Promise.all([
          getWorkspaceAction({ workspaceId }),
          getWorkspaceSessionsAction({ workspaceId }),
        ]);

        if (wsResult?.data) {
          setWorkspaceName(wsResult.data.name);
        }

        const fetched =
          (sessionsResult?.data as TmuxSession[] | undefined) ?? [];
        setSessions(fetched);

        if (fetched.length > 0 && !currentSession) {
          router.replace(
            `/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(fetched[0].name)}`,
          );
        } else if (fetched.length === 0) {
          const result = await createSessionAction({ workspaceId });
          if (result?.data) {
            setSessions([
              {
                name: result.data.name,
                created: Math.floor(Date.now() / 1000),
                windows: 1,
              },
            ]);
            router.replace(
              `/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(result.data.name)}`,
            );
          }
        }
      } catch (err) {
        console.error("[breadcrumbs] Failed to load data:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [workspaceId, currentSession, router]);

  const selectSession = useCallback(
    (name: string) => {
      router.replace(
        `/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(name)}`,
      );
      setPopoverOpen(false);
    },
    [router, workspaceId],
  );

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const result = await createSessionAction({ workspaceId });
      if (result?.data) {
        const newSession: TmuxSession = {
          name: result.data.name,
          created: Math.floor(Date.now() / 1000),
          windows: 1,
        };
        setSessions((prev) => [...prev, newSession]);
        selectSession(result.data.name);
      }
    } catch (err) {
      console.error("[breadcrumbs] Failed to create session:", err);
    } finally {
      setCreating(false);
    }
  }, [workspaceId, selectSession]);

  const handleDelete = useCallback(
    async (name: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await killSessionAction({ workspaceId, sessionName: name });
        setSessions((prev) => {
          const updated = prev.filter((s) => s.name !== name);
          if (currentSession === name && updated.length > 0) {
            selectSession(updated[0].name);
          }
          return updated;
        });
      } catch (err) {
        console.error("[breadcrumbs] Failed to delete session:", err);
      }
    },
    [workspaceId, currentSession, selectSession],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink render={<Link href="/workspaces" />}>
            Workspaces
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{workspaceName ?? workspaceId}</BreadcrumbPage>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Terminal</BreadcrumbPage>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-normal hover:bg-accent"
            >
              <Terminal className="h-3 w-3" />
              <span className="font-mono">
                {currentSession ?? "Select session"}
              </span>
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 gap-0 p-0">
              <div className="border-b p-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={handleCreate}
                  disabled={creating}
                >
                  {creating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  New Session
                </Button>
              </div>
              <div className="max-h-60 overflow-y-auto p-1">
                {sessions.length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    No sessions
                  </p>
                ) : (
                  sessions.map((session) => (
                    <div
                      key={session.name}
                      className={cn(
                        "group flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                        currentSession === session.name && "bg-accent",
                      )}
                      onClick={() => selectSession(session.name)}
                    >
                      <span className="truncate font-mono text-xs">
                        {session.name}
                      </span>
                      <button
                        type="button"
                        className="ml-2 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive group-hover:opacity-100"
                        onClick={(e) => handleDelete(session.name, e)}
                        title="Delete session"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
