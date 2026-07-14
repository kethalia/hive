"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { DashboardPageShell } from "@/components/dashboard-page-shell";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type KeepAliveStatus,
  parseKeepAliveStatusPayload,
  terminalProxyHttpBaseUrl,
} from "@/hooks/useKeepAliveStatus";
import { getClientRuntimeConfig } from "@/lib/runtime-config";

interface TerminalSessionStatusClientProps {
  highlightedWorkspaceId?: string;
}

interface StatusState {
  error: string | null;
  isLoading: boolean;
  lastUpdatedAt: string | null;
  workspaces: Record<string, KeepAliveStatus>;
}

const POLL_INTERVAL_MS = 30_000;

function statusBadge(status: KeepAliveStatus["status"]) {
  switch (status) {
    case "healthy":
      return <Badge className="bg-green-600 text-white">Healthy</Badge>;
    case "not-applicable":
      return <Badge variant="secondary">Not applicable</Badge>;
    case "recently-disconnected":
      return <Badge variant="secondary">Recently disconnected</Badge>;
    case "no-token":
      return <Badge variant="destructive">No token</Badge>;
    case "failing":
      return <Badge variant="destructive">Failing</Badge>;
  }
}

function formatValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function formatDuration(value: number | null): string {
  return value === null ? "—" : `${value}ms`;
}

function statusSummary(status: KeepAliveStatus): string {
  if (status.status === "not-applicable") {
    return "Coder reports keepalive extension is not applicable for this workspace.";
  }
  if (status.status === "failing") {
    return "Terminal proxy is connected to at least one session, but workspace keepalive is failing.";
  }
  if (status.status === "healthy") return "Keepalive is healthy for this workspace.";
  if (status.status === "recently-disconnected") {
    return "Terminal recently disconnected; row is retained for diagnosis.";
  }
  return "Terminal proxy has an active connection but no Coder token metadata for keepalive.";
}

function DetailGrid({ status }: { status: KeepAliveStatus }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <div>
        <dt className="text-muted-foreground">Active terminal connections</dt>
        <dd className="font-medium tabular-nums">{status.activeConnectionCount}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Consecutive failures</dt>
        <dd className="font-medium tabular-nums">{status.consecutiveFailures}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Last attempt duration</dt>
        <dd className="font-medium tabular-nums">{formatDuration(status.lastAttemptDurationMs)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Failure category</dt>
        <dd className="font-medium">{formatValue(status.lastFailureCategory)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Failure reason</dt>
        <dd className="font-medium">{formatValue(status.lastFailureReason)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">HTTP status</dt>
        <dd className="font-medium tabular-nums">
          {status.lastHttpStatus
            ? `${status.lastHttpStatus} ${status.lastHttpStatusText ?? ""}`
            : "—"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Last attempt</dt>
        <dd className="font-medium tabular-nums">{formatValue(status.lastAttempt)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Last success</dt>
        <dd className="font-medium tabular-nums">{formatValue(status.lastSuccess)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Last failure</dt>
        <dd className="font-medium tabular-nums">{formatValue(status.lastFailure)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Last disconnected</dt>
        <dd className="font-medium tabular-nums">{formatValue(status.lastDisconnectedAt)}</dd>
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <dt className="text-muted-foreground">Safe failure detail</dt>
        <dd className="font-medium">{formatValue(status.lastFailureDetail)}</dd>
      </div>
    </dl>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="space-y-1 pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

export function TerminalSessionStatusClient({
  highlightedWorkspaceId,
}: TerminalSessionStatusClientProps) {
  const mountedRef = useRef(true);
  const [state, setState] = useState<StatusState>({
    error: null,
    isLoading: true,
    lastUpdatedAt: null,
    workspaces: {},
  });

  const statusEndpoint = useMemo(() => {
    const terminalWsUrl = getClientRuntimeConfig().terminalWsUrl;
    return terminalWsUrl ? `${terminalProxyHttpBaseUrl(terminalWsUrl)}/keepalive/status` : null;
  }, []);

  const refresh = useCallback(async () => {
    if (!statusEndpoint) {
      if (!mountedRef.current) return;
      setState((current) => ({
        ...current,
        error:
          "NEXT_PUBLIC_TERMINAL_WS_URL is not configured; terminal proxy status is unavailable.",
        isLoading: false,
      }));
      return;
    }

    if (mountedRef.current) setState((current) => ({ ...current, isLoading: true }));
    try {
      const res = await fetch(statusEndpoint, { cache: "no-store", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload: unknown = await res.json();
      if (!mountedRef.current) return;
      setState({
        error: null,
        isLoading: false,
        lastUpdatedAt: new Date().toISOString(),
        workspaces: parseKeepAliveStatusPayload(payload),
      });
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : "Unknown status fetch error";
      setState((current) => ({ ...current, error: message, isLoading: false }));
    }
  }, [statusEndpoint]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const intervalId = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [refresh]);

  const workspaceEntries = Object.entries(state.workspaces).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const highlightedStatus = highlightedWorkspaceId
    ? state.workspaces[highlightedWorkspaceId]
    : null;
  const activeConnectionCount = workspaceEntries.reduce(
    (total, [, status]) => total + status.activeConnectionCount,
    0,
  );
  const failingCount = workspaceEntries.filter(([, status]) => status.status === "failing").length;
  const notApplicableCount = workspaceEntries.filter(
    ([, status]) => status.status === "not-applicable",
  ).length;

  return (
    <DashboardPageShell className="flex w-full flex-1 flex-col gap-4 space-y-0 overflow-auto">
      <DashboardPageHeader
        title="Terminal status"
        description="Aggregated keepalive status for terminal sessions authorized by your Coder account."
        leading={<p className="text-sm text-muted-foreground">Terminal diagnostics</p>}
        actions={
          <>
            <Link className={buttonVariants({ variant: "outline" })} href="/workspaces">
              Workspaces
            </Link>
            <Button onClick={() => void refresh()} disabled={state.isLoading}>
              <RefreshCw className="mr-2 size-4" />
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Workspace rows" value={workspaceEntries.length} />
        <MetricCard label="Active terminal connections" value={activeConnectionCount} />
        <MetricCard label="Failing rows" value={failingCount} />
        <MetricCard label="Not applicable" value={notApplicableCount} />
      </div>

      {state.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          Status fetch failed: {state.error}
        </p>
      ) : null}

      {highlightedWorkspaceId ? (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Highlighted workspace</CardTitle>
                <CardDescription>
                  <code className="rounded bg-muted px-1 py-0.5">{highlightedWorkspaceId}</code>
                </CardDescription>
              </div>
              {highlightedStatus ? (
                statusBadge(highlightedStatus.status)
              ) : (
                <Badge variant="outline">No row</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {highlightedStatus ? (
              <>
                <p className="text-sm text-muted-foreground">{statusSummary(highlightedStatus)}</p>
                <DetailGrid status={highlightedStatus} />
                <Link
                  className={buttonVariants({ variant: "outline" })}
                  href={`/workspaces/${encodeURIComponent(highlightedWorkspaceId)}/terminal`}
                >
                  Open terminal
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No active or recently-disconnected terminal connection is currently registered for
                this workspace, or the workspace is not visible to your authenticated Coder session.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Authorized terminal session rows</CardTitle>
          <CardDescription>
            Active and recently-disconnected terminal rows returned for your authenticated Coder
            session. Diagnostics are sanitized and never include terminal output, tokens, clone
            proofs, raw Coder URLs, command input, or sensitive paths.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {workspaceEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No terminal session rows are currently reported for your authorized workspaces.
              {state.isLoading ? " Loading…" : ""}
            </p>
          ) : (
            <div className="space-y-3">
              {workspaceEntries.map(([id, status]) => (
                <div key={id} className="rounded-lg border p-3">
                  <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <code className="break-all text-xs text-muted-foreground">{id}</code>
                      <p className="mt-1 text-sm text-muted-foreground">{statusSummary(status)}</p>
                    </div>
                    {statusBadge(status.status)}
                  </div>
                  <DetailGrid status={status} />
                  <div className="mt-3">
                    <Link
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                      href={`/workspaces/${encodeURIComponent(id)}/terminal`}
                    >
                      Open terminal
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Last updated: {formatValue(state.lastUpdatedAt)}.
          </p>
        </CardContent>
      </Card>
    </DashboardPageShell>
  );
}
