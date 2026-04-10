"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { RefreshCw, Upload, CheckCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TemplateStatus } from "@/lib/templates/staleness";

// xterm must not run on the server — dynamic import with ssr:false
const TerminalPanel = dynamic(
  () => import("./TerminalPanel").then((m) => m.TerminalPanel),
  { ssr: false }
);

interface PushState {
  jobId: string | null;
  inProgress: boolean;
  /** null = pending/in-progress, true = succeeded, false = failed */
  result: boolean | null;
  terminalOpen: boolean;
}

interface TemplatesClientProps {
  initialStatuses: TemplateStatus[];
}

/** Format an ISO date string as a human-readable relative time. */
function formatDate(iso: string | null): string {
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

export function TemplatesClient({ initialStatuses }: TemplatesClientProps) {
  const [statuses, setStatuses] = useState<TemplateStatus[]>(initialStatuses);
  const [pushStates, setPushStates] = useState<Record<string, PushState>>({});

  // writeRef per template — populated when TerminalPanel mounts
  const writeRefs = useRef<Record<string, React.MutableRefObject<((line: string) => void) | null>>>({});
  // All lines ever received for a push, keyed by template name.
  // Kept in a ref so TerminalPanel can replay them on mount regardless of timing.
  const lineHistory = useRef<Record<string, string[]>>({});

  // Get or create a writeRef for a template
  function getWriteRef(name: string): React.MutableRefObject<((line: string) => void) | null> {
    if (!writeRefs.current[name]) {
      writeRefs.current[name] = { current: null };
    }
    return writeRefs.current[name];
  }

  // Called by TerminalPanel once xterm is ready — replay full history so far.
  const handleTerminalReady = useCallback((name: string) => {
    const write = writeRefs.current[name]?.current;
    if (!write) return;
    for (const line of lineHistory.current[name] ?? []) {
      write(line);
    }
  }, []);

  // Record a line to history (capped) and write to terminal if ready
  const MAX_HISTORY_LINES = 2000;
  function writeLine(name: string, line: string) {
    if (!lineHistory.current[name]) lineHistory.current[name] = [];
    const history = lineHistory.current[name];
    if (history.length >= MAX_HISTORY_LINES) history.shift();
    history.push(line);
    writeRefs.current[name]?.current?.(line);
  }

  // ── Status polling ─────────────────────────────────────────────

  const refreshStatuses = useCallback(async () => {
    try {
      const res = await fetch("/api/templates/status");
      if (!res.ok) return;
      const data: TemplateStatus[] = await res.json();
      setStatuses(data);
    } catch {
      // Silent — stale data is fine
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(refreshStatuses, 30_000);
    return () => clearInterval(interval);
  }, [refreshStatuses]);

  // ── Push flow ──────────────────────────────────────────────────

  const handlePush = useCallback(async (name: string) => {
    // Start push — clear previous output history for this template
    lineHistory.current[name] = [];
    setPushStates((prev) => ({
      ...prev,
      [name]: { jobId: null, inProgress: true, result: null, terminalOpen: true },
    }));

    let jobId: string;
    try {
      const res = await fetch(`/api/templates/${name}/push`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        writeLine(name, `[error] ${body.error ?? "Failed to start push"}`);
        setPushStates((prev) => ({
          ...prev,
          [name]: { ...prev[name], inProgress: false, result: false },
        }));
        return;
      }
      const data = await res.json();
      jobId = data.jobId;
    } catch (err) {
      writeLine(name, `[error] ${err instanceof Error ? err.message : String(err)}`);
      setPushStates((prev) => ({
        ...prev,
        [name]: { ...prev[name], inProgress: false, result: false },
      }));
      return;
    }

    setPushStates((prev) => ({
      ...prev,
      [name]: { jobId, inProgress: true, result: null, terminalOpen: true },
    }));

    // Stream output
    const eventSource = new EventSource(`/api/templates/${name}/push/${jobId}/stream`);

    eventSource.onmessage = (ev) => {
      writeLine(name, ev.data);
    };

    eventSource.addEventListener("status", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        const success = payload.success === true;
        eventSource.close();
        // Always write a final status line so the terminal is never blank
        if (success) {
          writeLine(name, "\r\n\x1b[32m✓ Push succeeded\x1b[0m");
        } else {
          const errDetail = payload.error ? ` — ${payload.error}` : "";
          writeLine(name, `\r\n\x1b[31m✗ Push failed${errDetail}\x1b[0m`);
        }
        setPushStates((prev) => ({
          ...prev,
          [name]: { ...prev[name], inProgress: false, result: success },
        }));
        if (success) {
          // Refresh this template's status after a short delay
          setTimeout(refreshStatuses, 1000);
        }
      } catch {
        // Malformed status event — close anyway
        eventSource.close();
        setPushStates((prev) => ({
          ...prev,
          [name]: { ...prev[name], inProgress: false, result: false },
        }));
      }
    });

    eventSource.onerror = () => {
      eventSource.close();
      setPushStates((prev) => ({
        ...prev,
        [name]: { ...prev[name], inProgress: false, result: false },
      }));
    };
  }, [refreshStatuses]);

  const handleCloseTerminal = useCallback((name: string) => {
    setPushStates((prev) => ({
      ...prev,
      [name]: { ...prev[name], terminalOpen: false },
    }));
  }, []);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Templates</h1>
        <Button variant="outline" size="sm" onClick={refreshStatuses}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Last Pushed</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {statuses.map((status) => {
              const push = pushStates[status.name];
              const isInProgress = push?.inProgress === true;

              return (
                <TableRow key={status.name}>
                  <TableCell>
                    <code className="text-sm font-mono">{status.name}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(status.lastPushed)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={status}
                      pushResult={push?.result ?? null}
                      inProgress={isInProgress}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {push?.result === true && (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      )}
                      {push?.result === false && (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                      <Button
                        size="sm"
                        variant={status.stale ? "default" : "outline"}
                        disabled={isInProgress}
                        onClick={() => handlePush(status.name)}
                      >
                        {isInProgress ? (
                          <>
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Pushing…
                          </>
                        ) : (
                          <>
                            <Upload className="mr-1.5 h-3.5 w-3.5" />
                            Push
                          </>
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Terminal panels — one per in-progress or recently completed push */}
      {statuses.map((status) => {
        const push = pushStates[status.name];
        if (!push?.terminalOpen) return null;

        return (
          <div key={`terminal-${status.name}`} className="space-y-2">
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono text-muted-foreground">{status.name}</code>
              {push.result === true && (
                <Badge variant="secondary" className="text-green-600 border-green-600/30 bg-green-500/10">
                  Push succeeded
                </Badge>
              )}
              {push.result === false && (
                <Badge variant="destructive">Push failed</Badge>
              )}
            </div>
            <TerminalPanel
              writeRef={getWriteRef(status.name)}
              onClose={() => handleCloseTerminal(status.name)}
              onReady={() => handleTerminalReady(status.name)}
              className="h-64"
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Status badge sub-component ────────────────────────────────────

interface StatusBadgeProps {
  status: TemplateStatus;
  pushResult: boolean | null;
  inProgress: boolean;
}

function StatusBadge({ status, pushResult, inProgress }: StatusBadgeProps) {
  if (inProgress) {
    return (
      <Badge variant="outline" className="text-amber-500 border-amber-500/40 bg-amber-500/10">
        Pushing…
      </Badge>
    );
  }

  if (pushResult === true) {
    return (
      <Badge variant="outline" className="text-green-600 border-green-600/30 bg-green-500/10">
        Current
      </Badge>
    );
  }

  if (status.remoteHash === null) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Unknown
      </Badge>
    );
  }

  if (status.stale) {
    return (
      <Badge variant="outline" className="text-amber-500 border-amber-500/40 bg-amber-500/10">
        Stale
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-green-600 border-green-600/30 bg-green-500/10">
      Current
    </Badge>
  );
}
