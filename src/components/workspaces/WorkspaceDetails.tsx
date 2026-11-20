"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingStatus } from "@/components/ui/loading-status";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import type { CoderWorkspace, WorkspaceBuildLog, WorkspaceBuildStatus } from "@/lib/coder/types";

import { BuildLogTabs } from "./BuildLogTabs";

interface BuildSnapshot {
  workspace: CoderWorkspace;
  logs: WorkspaceBuildLog[];
}
export type WorkspaceOperationState = {
  pending?: "start" | "stop";
  failed?: "start" | "stop";
  error?: string;
};

const logTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

function WorkspaceStatus({
  status,
  operation,
}: {
  status: WorkspaceBuildStatus;
  operation?: WorkspaceOperationState;
}) {
  const transition =
    operation?.pending === "start"
      ? status === "running"
        ? "Finishing startup"
        : "Starting"
      : operation?.pending === "stop"
        ? "Stopping"
        : undefined;
  return transition ? (
    <LoadingStatus>{transition}…</LoadingStatus>
  ) : (
    <Badge
      role="status"
      variant={status === "running" ? "default" : status === "failed" ? "destructive" : "outline"}
    >
      <span className="capitalize">{status}</span>
    </Badge>
  );
}

function useWorkspaceBuildLogs(
  workspaceId: string,
  userId: string,
  visible: boolean,
  pending: WorkspaceOperationState["pending"],
) {
  const query = useQuery({
    queryKey: ["workspace-build-logs", userId, workspaceId],
    enabled: visible,
    queryFn: async ({ client, queryKey, signal }): Promise<BuildSnapshot> => {
      const previous = client.getQueryData<BuildSnapshot>(queryKey);
      const params = new URLSearchParams();
      if (previous) {
        params.set("build", previous.workspace.latest_build.id);
        params.set("after", String(previous.logs.at(-1)?.id ?? 0));
      }
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/build-logs?${params}`,
        { signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error("Build logs unavailable.");
      const next: BuildSnapshot = await response.json();
      if (previous?.workspace.latest_build.id === next.workspace.latest_build.id) {
        const cursor = previous.logs.at(-1)?.id ?? 0;
        next.logs = [...previous.logs, ...next.logs.filter((line) => line.id > cursor)].slice(-250);
      }
      return next;
    },
    retry: false,
    refetchInterval: (query) => {
      if (!visible) return false;
      const status = query.state.data?.workspace.latest_build.status;
      return pending ||
        !status ||
        ["starting", "pending", "stopping", "canceling", "deleting"].includes(status)
        ? 2000
        : 15000;
    },
  });
  const lastOperation = useRef(pending);
  const { refetch } = query;
  useEffect(() => {
    if (visible && lastOperation.current && !pending) void refetch();
    lastOperation.current = pending;
  }, [visible, pending, refetch]);
  const snapshot = query.isError ? undefined : query.data;
  return { snapshot, failed: query.isError, retry: refetch };
}

export function WorkspaceDetails({
  workspace,
  userId,
  visible,
  operation,
  onStart,
  onStop,
  renderWindow,
}: {
  workspace: CoderWorkspace;
  userId: string;
  visible: boolean;
  operation?: WorkspaceOperationState;
  onStart: () => void;
  onStop: () => void;
  renderWindow: (status: ReactNode, content: ReactNode) => ReactNode;
}) {
  const logs = useWorkspaceBuildLogs(workspace.id, userId, visible, operation?.pending);
  const current = logs.snapshot?.workspace ?? workspace;
  const build = current.latest_build;
  return renderWindow(
    <WorkspaceStatus status={build.status} operation={operation} />,
    <div className="space-y-5 p-4">
      {!operation?.pending && (build.status === "running" || build.status === "stopped") && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={build.status === "running" ? onStop : onStart}>
            {build.status === "running" ? "Stop workspace" : "Start workspace"}
          </Button>
        </div>
      )}
      {operation?.error && (
        <p role="alert" className="text-destructive">
          {operation.error}
        </p>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm [&_dt]:text-muted-foreground [&_dd]:break-words">
        <dt>Workspace</dt>
        <dd>{current.name}</dd>
        <dt>Owner</dt>
        <dd>{current.owner_name}</dd>
        <dt>Template</dt>
        <dd>{current.template_display_name || current.template_name || current.template_id}</dd>
        {current.health && (
          <>
            <dt>Health</dt>
            <dd>{current.health.healthy ? "Healthy" : "Unhealthy"}</dd>
          </>
        )}
        {current.last_used_at && (
          <>
            <dt>Last used</dt>
            <dd>{new Date(current.last_used_at).toLocaleString()}</dd>
          </>
        )}
        <dt>Build</dt>
        <dd>{build.id}</dd>
        <dt>Build status</dt>
        <dd>{build.job?.status}</dd>
      </dl>
      {build.job?.error && (
        <p role="alert" className="text-destructive">
          {build.job.error}
        </p>
      )}
      <section aria-label="Build logs" className="space-y-2">
        <h2 className="font-semibold">Build logs</h2>
        {logs.failed ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              Could not load build logs.
            </p>
            <Button variant="outline" onClick={() => void logs.retry()}>
              Retry
            </Button>
          </div>
        ) : !logs.snapshot ? (
          <LoadingStatus>Loading build logs…</LoadingStatus>
        ) : (
          <BuildLogViewer
            key={build.id}
            lines={logs.snapshot.logs}
            workspaceName={current.name}
            visible={visible}
          />
        )}
      </section>
    </div>,
  );
}

function BuildLogViewer({
  lines,
  workspaceName,
  visible,
}: {
  lines: WorkspaceBuildLog[];
  workspaceName: string;
  visible: boolean;
}) {
  const [stage, setStage] = useState("");
  const stages = useMemo(
    () => ["", ...new Set(lines.map((line) => line.stage).filter(Boolean))],
    [lines],
  );
  const activeStage = stages.includes(stage) ? stage : "";
  const filtered = activeStage ? lines.filter((line) => line.stage === activeStage) : lines;
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const lastLine = filtered.at(-1)?.id;
  useEffect(() => {
    if (visible && lastLine !== undefined && list.current && follow.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [visible, lastLine]);

  function logText() {
    return filtered
      .map((line) => [line.created_at, line.stage, line.output].filter(Boolean).join(" "))
      .join("\n");
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logText());
      toast.success("Build logs copied");
    } catch {
      toast.error("Could not copy build logs");
    }
  }

  function downloadLogs() {
    const url = URL.createObjectURL(new Blob([logText()], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${workspaceName}-build.log`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function changeStage(stage: string) {
    follow.current = true;
    setStage(stage);
  }

  return (
    <Tabs
      value={activeStage}
      onValueChange={changeStage}
      className="min-w-0 gap-0 overflow-hidden rounded-md border border-border bg-black"
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-2 py-1">
        <BuildLogTabs stages={stages} value={activeStage} onChange={changeStage} />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Copy build logs"
            title="Copy build logs"
            disabled={!filtered.length}
            onClick={() => void copyLogs()}
          >
            <Copy aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Download build logs"
            title="Download build logs"
            disabled={!filtered.length}
            onClick={downloadLogs}
          >
            <Download aria-hidden />
          </Button>
        </div>
      </div>
      <TabsContent value={activeStage}>
        {filtered.length ? (
          <ol
            ref={list}
            onScroll={(event) => {
              const element = event.currentTarget;
              follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 8;
            }}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The log viewport must be keyboard scrollable.
            tabIndex={0}
            aria-label="Latest build output"
            className="max-h-80 overflow-y-auto overscroll-contain px-2 py-1.5 font-mono text-xs focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {filtered.map((line, index) => (
              <li
                key={line.id}
                className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 px-1 py-0.5 leading-5 hover:bg-muted/25"
              >
                <time
                  dateTime={line.created_at}
                  className="self-start text-muted-foreground tabular-nums"
                >
                  {logTime.format(new Date(line.created_at))}
                </time>
                <div className="min-w-0 border-l border-border pl-2">
                  {!activeStage && line.stage && line.stage !== filtered[index - 1]?.stage && (
                    <div className="font-medium text-muted-foreground [overflow-wrap:anywhere]">
                      {line.stage}
                    </div>
                  )}
                  <div
                    className="whitespace-pre-wrap [overflow-wrap:anywhere] data-[level=error]:text-destructive data-[level=warn]:text-yellow-300"
                    data-level={line.log_level}
                  >
                    {line.output}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
            No output for this build yet.
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}
