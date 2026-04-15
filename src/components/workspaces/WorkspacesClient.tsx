"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  FolderOpen,
  Monitor,
  Code,
  ChevronDown,
  ChevronRight,
  Terminal,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import type { CoderWorkspace, WorkspaceBuildStatus } from "@/lib/coder/types";
import { listWorkspacesAction } from "@/lib/actions/workspaces";

interface WorkspacesClientProps {
  initialWorkspaces: CoderWorkspace[];
  coderUrl: string;
}

const STATUS_BADGE: Record<
  string,
  {
    variant: "default" | "secondary" | "destructive" | "outline";
    className: string;
    label: string;
  }
> = {
  running: { variant: "default", className: "bg-green-600 text-white", label: "Running" },
  starting: { variant: "secondary", className: "bg-yellow-600 text-white", label: "Starting" },
  stopping: { variant: "secondary", className: "bg-yellow-600 text-white", label: "Stopping" },
  stopped: { variant: "secondary", className: "", label: "Stopped" },
  failed: { variant: "destructive", className: "", label: "Failed" },
  deleted: { variant: "secondary", className: "", label: "Deleted" },
  deleting: { variant: "secondary", className: "", label: "Deleting" },
  pending: { variant: "secondary", className: "bg-yellow-600 text-white", label: "Pending" },
  canceling: { variant: "secondary", className: "", label: "Canceling" },
  canceled: { variant: "secondary", className: "", label: "Canceled" },
};

const DEFAULT_STATUS_BADGE = { variant: "outline" as const, className: "", label: "Unknown" };

function getStatusBadge(status: WorkspaceBuildStatus) {
  return STATUS_BADGE[status] ?? DEFAULT_STATUS_BADGE;
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

function getWorkspaceAppUrls(ws: CoderWorkspace, coderUrl: string) {
  if (!coderUrl) return null;
  const stripped = coderUrl.replace(/\/+$/, "");
  const host = stripped.replace(/^https?:\/\//, "");
  const agent = "main";
  return {
    filebrowser: `https://filebrowser--${agent}--${ws.name}--${ws.owner_name}.${host}`,
    kasmvnc: `https://kasm-vnc--${agent}--${ws.name}--${ws.owner_name}.${host}`,
    codeServer: `https://code-server--${agent}--${ws.name}--${ws.owner_name}.${host}`,
  };
}

export function WorkspacesClient({ initialWorkspaces, coderUrl }: WorkspacesClientProps) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<CoderWorkspace[]>(initialWorkspaces);
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

  const toggleExpand = useCallback((wsId: string) => {
    setExpandedId((prev) => (prev === wsId ? null : wsId));
  }, []);

  const openPopup = useCallback((url: string, title: string) => {
    window.open(url, title, "width=1200,height=800,menubar=no,toolbar=no");
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Workspaces</h1>
        <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {workspaces.length === 0 && !error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Monitor className="text-muted-foreground mb-4 h-12 w-12" />
            <p className="text-muted-foreground text-lg">No workspaces found</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Create a workspace in Coder to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {workspaces.map((ws) => {
            const statusBadge = getStatusBadge(ws.latest_build.status);
            const isRunning = ws.latest_build.status === "running";
            const isExpanded = expandedId === ws.id;
            const urls = isRunning ? getWorkspaceAppUrls(ws, coderUrl) : null;

            return (
              <Collapsible key={ws.id} open={isExpanded}>
                <div
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/50 data-[state=open]:rounded-b-none"
                  data-state={isExpanded ? "open" : "closed"}
                  onClick={() => toggleExpand(ws.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleExpand(ws.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="shrink-0">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{ws.name}</span>
                      <Badge
                        variant={statusBadge.variant}
                        className={statusBadge.className}
                      >
                        {statusBadge.label}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {ws.template_display_name ?? ws.template_name ?? "—"}
                      {" · "}
                      {ws.owner_name}
                      {" · "}
                      {formatRelativeTime(ws.last_used_at)}
                    </div>
                  </div>
                </div>
                <CollapsibleContent>
                  <div className="flex items-center gap-2 rounded-b-lg border-x border-b border-border bg-card/50 px-4 py-3">
                    {urls ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPopup(urls.filebrowser, "Filebrowser");
                          }}
                        >
                          <FolderOpen className="mr-2 h-4 w-4" />
                          Filebrowser
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPopup(urls.kasmvnc, "KasmVNC");
                          }}
                        >
                          <Monitor className="mr-2 h-4 w-4" />
                          KasmVNC
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPopup(urls.codeServer, "Code Server");
                          }}
                        >
                          <Code className="mr-2 h-4 w-4" />
                          Code Server
                        </Button>
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/workspaces/${ws.id}/terminal`);
                          }}
                        >
                          <Terminal className="mr-2 h-4 w-4" />
                          Terminal
                        </Button>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Workspace is {ws.latest_build.status} — apps unavailable
                      </p>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
}
