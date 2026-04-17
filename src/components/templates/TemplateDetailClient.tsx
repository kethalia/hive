"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowLeft, RefreshCw, Upload, CheckCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TemplateStatus } from "@/lib/templates/staleness";

const TerminalPanel = dynamic(
  () => import("./TerminalPanel").then((m) => m.TerminalPanel),
  { ssr: false }
);

interface PushState {
  jobId: string | null;
  inProgress: boolean;
  result: boolean | null;
  terminalOpen: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());
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

interface TemplateDetailClientProps {
  status: TemplateStatus;
}

export function TemplateDetailClient({ status }: TemplateDetailClientProps) {
  const [pushState, setPushState] = useState<PushState>({
    jobId: null,
    inProgress: false,
    result: null,
    terminalOpen: false,
  });

  const writeRef = useRef<((line: string) => void) | null>(null);
  const lineHistory = useRef<string[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const MAX_HISTORY_LINES = 2000;

  function writeLine(line: string) {
    if (lineHistory.current.length >= MAX_HISTORY_LINES) lineHistory.current.shift();
    lineHistory.current.push(line);
    writeRef.current?.(line);
  }

  const handleTerminalReady = useCallback(() => {
    const write = writeRef.current;
    if (!write) return;
    for (const line of lineHistory.current) {
      write(line);
    }
  }, []);

  const handlePush = useCallback(async () => {
    lineHistory.current = [];
    setPushState({ jobId: null, inProgress: true, result: null, terminalOpen: true });

    let jobId: string;
    try {
      const res = await fetch(`/api/templates/${status.name}/push`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        writeLine(`[error] ${body.error ?? "Failed to start push"}`);
        setPushState((prev) => ({ ...prev, inProgress: false, result: false }));
        return;
      }
      const data = await res.json();
      jobId = data.jobId;
    } catch (err) {
      writeLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
      setPushState((prev) => ({ ...prev, inProgress: false, result: false }));
      return;
    }

    setPushState((prev) => ({ ...prev, jobId }));

    eventSourceRef.current?.close();
    const eventSource = new EventSource(`/api/templates/${status.name}/push/${jobId}/stream`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (ev) => {
      writeLine(ev.data);
    };

    eventSource.addEventListener("status", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data);
        const success = payload.success === true;
        eventSource.close();
        if (success) {
          writeLine("\r\n\x1b[32m\u2713 Push succeeded\x1b[0m");
        } else {
          const errDetail = payload.error ? ` \u2014 ${payload.error}` : "";
          writeLine(`\r\n\x1b[31m\u2717 Push failed${errDetail}\x1b[0m`);
        }
        setPushState((prev) => ({ ...prev, inProgress: false, result: success }));
      } catch {
        eventSource.close();
        setPushState((prev) => ({ ...prev, inProgress: false, result: false }));
      }
    });

    eventSource.onerror = () => {
      eventSource.close();
      setPushState((prev) => ({ ...prev, inProgress: false, result: false }));
    };
  }, [status.name]);

  const handleCloseTerminal = useCallback(() => {
    setPushState((prev) => ({ ...prev, terminalOpen: false }));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/templates">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold tracking-tight font-mono">{status.name}</h1>
        <StatusBadge
          stale={status.stale}
          remoteHash={status.remoteHash}
          pushResult={pushState.result}
          inProgress={pushState.inProgress}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Template Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Last Pushed</dt>
              <dd className="mt-0.5 font-medium">{formatDate(status.lastPushed)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Active Version ID</dt>
              <dd className="mt-0.5 font-mono text-xs">{status.activeVersionId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Local Hash</dt>
              <dd className="mt-0.5 font-mono text-xs break-all">
                {status.localHash || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Remote Hash</dt>
              <dd className="mt-0.5 font-mono text-xs break-all">
                {status.remoteHash ?? "—"}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          variant={status.stale ? "default" : "outline"}
          disabled={pushState.inProgress}
          onClick={handlePush}
        >
          {pushState.inProgress ? (
            <>
              <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" />
              Pushing…
            </>
          ) : (
            <>
              <Upload className="mr-1.5 h-4 w-4" />
              Push
            </>
          )}
        </Button>
        {pushState.result === true && (
          <span className="flex items-center gap-1.5 text-sm text-green-600">
            <CheckCircle className="h-4 w-4" />
            Push succeeded
          </span>
        )}
        {pushState.result === false && (
          <span className="flex items-center gap-1.5 text-sm text-destructive">
            <XCircle className="h-4 w-4" />
            Push failed
          </span>
        )}
      </div>

      {pushState.terminalOpen && (
        <TerminalPanel
          writeRef={writeRef}
          onClose={handleCloseTerminal}
          onReady={handleTerminalReady}
          className="h-64"
        />
      )}
    </div>
  );
}

function StatusBadge({
  stale,
  remoteHash,
  pushResult,
  inProgress,
}: {
  stale: boolean;
  remoteHash: string | null;
  pushResult: boolean | null;
  inProgress: boolean;
}) {
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
  if (remoteHash === null) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Unknown
      </Badge>
    );
  }
  if (stale) {
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
