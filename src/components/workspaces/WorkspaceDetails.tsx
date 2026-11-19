"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { CoderWorkspace } from "@/lib/coder/types";

interface BuildSnapshot {
  workspace: CoderWorkspace;
  logs: { id: number; output: string; stage: string; created_at: string }[];
}
export type WorkspaceOperationState = { pending?: "start" | "stop"; error?: string };

export function WorkspaceDetails({
  workspace,
  userId,
  visible,
  operation,
  onStart,
  onStop,
}: {
  workspace: CoderWorkspace;
  userId: string;
  visible: boolean;
  operation?: WorkspaceOperationState;
  onStart: () => void;
  onStop: () => void;
}) {
  const query = useQuery({
    queryKey: ["workspace-build-logs", userId, workspace.id],
    enabled: visible,
    queryFn: async ({ client, queryKey, signal }): Promise<BuildSnapshot> => {
      const previous = client.getQueryData<BuildSnapshot>(queryKey);
      const params = new URLSearchParams();
      if (previous) {
        params.set("build", previous.workspace.latest_build.id);
        params.set("after", String(previous.logs.at(-1)?.id ?? 0));
      }
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspace.id)}/build-logs?${params}`,
        { signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error("Build logs unavailable.");
      const next: BuildSnapshot = await response.json();
      if (previous?.workspace.latest_build.id === next.workspace.latest_build.id) {
        next.logs = [...previous.logs, ...next.logs].slice(-250);
      }
      return next;
    },
    retry: false,
    refetchInterval: (query) => {
      if (!visible) return false;
      const status = query.state.data?.workspace.latest_build.status;
      return operation?.pending ||
        !status ||
        ["starting", "pending", "stopping", "canceling", "deleting"].includes(status)
        ? 2000
        : 15000;
    },
  });
  const lastOperation = useRef(operation?.pending);
  const { refetch } = query;
  useEffect(() => {
    if (visible && lastOperation.current && !operation?.pending) void refetch();
    lastOperation.current = operation?.pending;
  }, [visible, operation?.pending, refetch]);
  const snapshot = query.isError ? undefined : query.data;
  const logList = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const latestLine = snapshot?.logs.at(-1)?.id;
  const buildId = snapshot?.workspace.latest_build.id;
  const previousBuild = useRef(buildId);
  useEffect(() => {
    const list = logList.current;
    if (buildId !== previousBuild.current) {
      follow.current = true;
      previousBuild.current = buildId;
    }
    if (visible && latestLine !== undefined && list && follow.current)
      list.scrollTop = list.scrollHeight;
  }, [latestLine, buildId, visible]);
  const current = snapshot?.workspace ?? workspace;
  const build = current.latest_build;
  return (
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="flex items-center gap-2">
          {operation?.pending && (
            <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          )}
          {operation?.pending === "start"
            ? "Starting workspace…"
            : operation?.pending === "stop"
              ? "Stopping workspace…"
              : build.status}
        </p>
        {!operation?.pending && (build.status === "running" || build.status === "stopped") && (
          <Button variant="outline" onClick={build.status === "running" ? onStop : onStart}>
            {build.status === "running" ? "Stop workspace" : "Start workspace"}
          </Button>
        )}
      </div>
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
        {query.isError ? (
          <div>
            <p role="alert">Could not load build logs.</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : !snapshot ? (
          <p role="status">Loading build logs…</p>
        ) : !snapshot.logs.length ? (
          <p role="status">No output for this build yet.</p>
        ) : (
          <ol
            ref={logList}
            onScroll={(event) => {
              const list = event.currentTarget;
              follow.current = list.scrollHeight - list.clientHeight - list.scrollTop < 8;
            }}
            aria-label="Latest build output"
            className="max-h-80 space-y-1 overflow-y-auto overscroll-contain rounded-md border p-3 font-mono text-xs"
          >
            {snapshot.logs.map((line) => (
              <li key={line.id} className="whitespace-pre-wrap break-words">
                <span className="text-muted-foreground">
                  {new Date(line.created_at).toLocaleTimeString()} {line.stage}
                </span>{" "}
                {line.output}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
