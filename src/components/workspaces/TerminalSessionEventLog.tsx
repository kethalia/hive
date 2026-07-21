"use client";

import { Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRuntimeConfig } from "@/components/runtime-config-provider";
import { Button } from "@/components/ui/button";
import { terminalProxyHttpBaseUrl } from "@/hooks/useKeepAliveStatus";
import {
  parseTerminalSessionEventPayload,
  type TerminalSessionEvent,
} from "@/lib/terminal/session-events";
import { cn } from "@/lib/utils";

interface TerminalSessionEventLogProps {
  workspaceId?: string;
  sessionName?: string;
  className?: string;
  compact?: boolean;
}

const POLL_INTERVAL_MS = 1_000;
const MAX_RENDERED_EVENTS = 500;

function formatDetails(event: TerminalSessionEvent): string {
  return Object.entries(event.details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString().slice(11, 23);
}

export function TerminalSessionEventLog({
  workspaceId,
  sessionName,
  className,
  compact = false,
}: TerminalSessionEventLogProps) {
  const { terminalWsUrl } = useRuntimeConfig();
  const [events, setEvents] = useState<TerminalSessionEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const instanceIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endpoint = useMemo(
    () => (terminalWsUrl ? `${terminalProxyHttpBaseUrl(terminalWsUrl)}/session-events` : null),
    [terminalWsUrl],
  );

  const refresh = useCallback(
    async (replace = false) => {
      if (!endpoint) {
        if (mountedRef.current) setError("Terminal proxy event logging is not configured.");
        return;
      }
      const params = new URLSearchParams({ limit: String(MAX_RENDERED_EVENTS) });
      if (workspaceId) params.set("workspaceId", workspaceId);
      if (!replace && lastEventIdRef.current > 0) {
        params.set("after", String(lastEventIdRef.current));
      }
      try {
        const response = await fetch(`${endpoint}?${params.toString()}`, {
          cache: "no-store",
          credentials: "include",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = parseTerminalSessionEventPayload(await response.json());
        if (!payload) throw new Error("Malformed terminal event response");
        if (!mountedRef.current) return;

        const instanceChanged = instanceIdRef.current !== payload.instanceId;
        instanceIdRef.current = payload.instanceId;
        setEvents((current) => {
          const next =
            replace || instanceChanged ? payload.events : [...current, ...payload.events];
          const unique = new Map(next.map((event) => [event.id, event]));
          return [...unique.values()].slice(-MAX_RENDERED_EVENTS);
        });
        lastEventIdRef.current =
          payload.events.at(-1)?.id ?? (instanceChanged ? 0 : lastEventIdRef.current);
        setError(null);
        setLastUpdatedAt(payload.generatedAt);
      } catch (refreshError) {
        if (!mountedRef.current) return;
        setError(refreshError instanceof Error ? refreshError.message : "Event refresh failed");
      }
    },
    [endpoint, workspaceId],
  );

  useEffect(() => {
    mountedRef.current = true;
    instanceIdRef.current = null;
    lastEventIdRef.current = 0;
    setEvents([]);
    void refresh(true);
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (paused) return;
    const intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [paused, refresh]);

  const visibleEvents = sessionName
    ? events.filter((event) => event.sessionName === sessionName)
    : events;

  useEffect(() => {
    if (paused || visibleEvents.length === 0) return;
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [paused, visibleEvents.length]);

  return (
    <section
      className={cn("flex min-h-0 flex-1 flex-col bg-zinc-950 text-zinc-100", className)}
      data-testid="terminal-session-event-log"
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-white/10 px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
          {sessionName ? `session=${sessionName}` : `workspace=${workspaceId ?? "all"}`}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-zinc-500">
          {visibleEvents.length} events
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 px-1.5 text-zinc-300 hover:bg-white/10 hover:text-white"
          aria-label={paused ? "Resume live session logs" : "Pause live session logs"}
          onClick={() => setPaused((current) => !current)}
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 px-1.5 text-zinc-300 hover:bg-white/10 hover:text-white"
          aria-label="Refresh session logs"
          onClick={() => void refresh(true)}
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>
      {error ? (
        <p className="border-b border-red-500/30 bg-red-500/10 px-2 py-1 font-mono text-[11px] text-red-300">
          event stream unavailable: {error}
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          "min-h-0 flex-1 overflow-auto overscroll-contain font-mono",
          compact ? "text-[10px] leading-4" : "text-[11px] leading-5",
        )}
        role="log"
        aria-label="Terminal session events"
        aria-live="off"
      >
        {visibleEvents.length === 0 ? (
          <p className="p-3 text-zinc-500">No session events recorded yet.</p>
        ) : (
          <ol className="min-w-max p-2">
            {visibleEvents.map((event) => (
              <li
                key={`${event.connectionId}:${event.id}`}
                className={cn(
                  "grid grid-cols-[5.5rem_4rem_9rem_12rem_minmax(12rem,1fr)] gap-2 border-b border-white/5 px-1 [content-visibility:auto]",
                  event.level === "error" && "text-red-300",
                  event.level === "warning" && "text-amber-300",
                )}
              >
                <time className="tabular-nums text-zinc-500">{formatTime(event.timestamp)}</time>
                <span>{event.sessionKind}</span>
                <span className="truncate" title={event.sessionName}>
                  {event.sessionName}
                </span>
                <span>{event.type}</span>
                <span className="text-zinc-400">{formatDetails(event)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {!compact ? (
        <p className="shrink-0 border-t border-white/10 px-2 py-1 text-[10px] text-zinc-500">
          Sanitized metadata only—command input, terminal output, tokens, proofs, and paths are
          never recorded. Last updated {lastUpdatedAt ?? "—"}.
        </p>
      ) : null}
    </section>
  );
}
