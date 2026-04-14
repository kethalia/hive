"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  FolderOpen,
  Monitor,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CoderWorkspace, WorkspaceBuildStatus } from "@/lib/coder/types";
import type { TmuxSession } from "@/lib/workspaces/sessions";
import type { WorkspaceUrls } from "@/lib/workspaces/urls";
import {
  listWorkspacesAction,
  getWorkspaceSessionsAction,
} from "@/lib/actions/workspaces";

interface WorkspacesClientProps {
  initialWorkspaces: CoderWorkspace[];
}

const STATUS_CONFIG: Record<
  string,
  { color: string; dotColor: string; label: string }
> = {
  running: {
    color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    dotColor: "bg-green-500",
    label: "Running",
  },
  starting: {
    color:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    dotColor: "bg-yellow-500",
    label: "Starting",
  },
  stopping: {
    color:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    dotColor: "bg-yellow-500",
    label: "Stopping",
  },
  stopped: {
    color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
    dotColor: "bg-gray-400",
    label: "Stopped",
  },
  failed: {
    color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    dotColor: "bg-red-500",
    label: "Failed",
  },
  deleted: {
    color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
    dotColor: "bg-gray-400",
    label: "Deleted",
  },
  deleting: {
    color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
    dotColor: "bg-gray-400",
    label: "Deleting",
  },
  pending: {
    color:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    dotColor: "bg-yellow-500",
    label: "Pending",
  },
  canceling: {
    color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
    dotColor: "bg-gray-400",
    label: "Canceling",
  },
  canceled: {
    color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
    dotColor: "bg-gray-400",
    label: "Canceled",
  },
};

const DEFAULT_STATUS = {
  color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  dotColor: "bg-gray-400",
  label: "Unknown",
};

function getStatusConfig(status: WorkspaceBuildStatus) {
  return STATUS_CONFIG[status] ?? DEFAULT_STATUS;
}

function canExpandSessions(status: WorkspaceBuildStatus): boolean {
  return status === "running" || status === "starting";
}

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMin = Math.floor(diffMs / (1000 * 60));
      return diffMin <= 1 ? "just now" : `${diffMin}m ago`;
    }
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatTimestamp(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}

interface SessionState {
  sessions: TmuxSession[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
}

export function WorkspacesClient({ initialWorkspaces }: WorkspacesClientProps) {
  const router = useRouter();
  const [workspaces, setWorkspaces] =
    useState<CoderWorkspace[]>(initialWorkspaces);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sessionMap, setSessionMap] = useState<Map<string, SessionState>>(
    new Map(),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await listWorkspacesAction();
      if (result?.data) {
        setWorkspaces(result.data);
      } else {
        setError("Failed to refresh workspaces");
      }
    } catch {
      setError("Failed to refresh workspaces");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const toggleExpand = useCallback(
    async (workspace: CoderWorkspace) => {
      const wsId = workspace.id;
      if (expandedId === wsId) {
        setExpandedId(null);
        return;
      }

      if (!canExpandSessions(workspace.latest_build.status)) {
        return;
      }

      setExpandedId(wsId);

      const existing = sessionMap.get(wsId);
      if (existing?.loaded) return;

      setSessionMap((prev) => {
        const next = new Map(prev);
        next.set(wsId, {
          sessions: [],
          loading: true,
          error: null,
          loaded: false,
        });
        return next;
      });

      try {
        const result = await getWorkspaceSessionsAction({
          workspaceId: wsId,
        });
        setSessionMap((prev) => {
          const next = new Map(prev);
          next.set(wsId, {
            sessions: (result?.data as TmuxSession[] | undefined) ?? [],
            loading: false,
            error: null,
            loaded: true,
          });
          return next;
        });
      } catch {
        setSessionMap((prev) => {
          const next = new Map(prev);
          next.set(wsId, {
            sessions: [],
            loading: false,
            error: "Failed to load sessions",
            loaded: false,
          });
          return next;
        });
      }
    },
    [expandedId, sessionMap],
  );

  const getToolLinks = (
    workspace: CoderWorkspace,
  ): WorkspaceUrls | null => {
    const coderUrl = typeof window !== "undefined"
      ? (process.env.NEXT_PUBLIC_CODER_URL ?? "")
      : "";
    if (!coderUrl) return null;
    const agentName = "main";
    const stripped = coderUrl.replace(/\/+$/, "");
    const host = stripped.replace(/^https?:\/\//, "");
    return {
      filebrowser: `https://filebrowser--${agentName}--${workspace.name}--${workspace.owner_name}.${host}`,
      kasmvnc: `https://kasmvnc--${agentName}--${workspace.name}--${workspace.owner_name}.${host}`,
      dashboard: `${stripped}/@${workspace.owner_name}/${workspace.name}`,
    };
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Workspaces</h1>
        <Button
          variant="outline"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Empty state */}
      {workspaces.length === 0 && !error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Monitor className="text-muted-foreground mb-4 h-12 w-12" />
            <p className="text-muted-foreground text-lg">
              No workspaces found
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              Create a workspace in Coder to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {workspaces.map((ws) => {
            const status = getStatusConfig(ws.latest_build.status);
            const isExpanded = expandedId === ws.id;
            const canExpand = canExpandSessions(ws.latest_build.status);
            const sessionState = sessionMap.get(ws.id);
            const toolLinks = getToolLinks(ws);

            return (
              <Card key={ws.id} className="overflow-hidden">
                <div
                  className={`flex items-center gap-4 px-4 py-3 ${canExpand ? "cursor-pointer hover:bg-muted/50" : ""}`}
                  onClick={() => toggleExpand(ws)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleExpand(ws);
                    }
                  }}
                  role={canExpand ? "button" : undefined}
                  tabIndex={canExpand ? 0 : undefined}
                >
                  {/* Expand/collapse icon */}
                  <div className="w-5 shrink-0">
                    {canExpand ? (
                      isExpanded ? (
                        <ChevronDown className="text-muted-foreground h-4 w-4" />
                      ) : (
                        <ChevronRight className="text-muted-foreground h-4 w-4" />
                      )
                    ) : null}
                  </div>

                  {/* Workspace info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">
                        {ws.name}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${status.color}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${status.dotColor}`}
                        />
                        {status.label}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 flex items-center gap-3 text-xs">
                      <span>
                        {ws.template_display_name ?? ws.template_name ?? "—"}
                      </span>
                      <span>·</span>
                      <span>{ws.owner_name}</span>
                      <span>·</span>
                      <span>
                        {formatRelativeTime(ws.last_used_at)}
                      </span>
                    </div>
                  </div>

                  {/* Tool links */}
                  {ws.latest_build.status === "running" && toolLinks && (
                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <a
                        href={toolLinks.filebrowser}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Filebrowser"
                      >
                        <Button variant="ghost" size="icon">
                          <FolderOpen className="h-4 w-4" />
                        </Button>
                      </a>
                      <a
                        href={toolLinks.kasmvnc}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="KasmVNC"
                      >
                        <Button variant="ghost" size="icon">
                          <Monitor className="h-4 w-4" />
                        </Button>
                      </a>
                      <a
                        href={toolLinks.dashboard}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Coder Dashboard"
                      >
                        <Button variant="ghost" size="icon">
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </a>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="New Terminal"
                        onClick={() => router.push(`/workspaces/${ws.id}/terminal`)}
                      >
                        <Terminal className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>

                {/* Expanded sessions panel */}
                {isExpanded && canExpand && (
                  <div className="border-t bg-muted/30 px-4 py-3">
                    {sessionState?.loading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading sessions…
                      </div>
                    ) : sessionState?.error ? (
                      <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                        <AlertCircle className="h-4 w-4" />
                        {sessionState.error}
                      </div>
                    ) : sessionState?.sessions.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No tmux sessions running
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Tmux Sessions
                        </p>
                        {sessionState?.sessions.map((session) => (
                          <div
                            key={session.name}
                            className="flex items-center gap-3 rounded-md bg-background px-3 py-2 text-sm"
                          >
                            <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="font-mono font-medium">
                              {session.name}
                            </span>
                            <span className="text-muted-foreground">
                              {session.windows} window
                              {session.windows !== 1 ? "s" : ""}
                            </span>
                            <span className="ml-auto flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">
                                {formatTimestamp(session.created)}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  router.push(`/workspaces/${ws.id}/terminal?session=${encodeURIComponent(session.name)}`);
                                }}
                              >
                                Connect
                              </Button>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {!canExpandSessions(ws.latest_build.status) && (
                      <p className="text-sm text-muted-foreground">
                        Workspace is {ws.latest_build.status} — sessions unavailable
                      </p>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
