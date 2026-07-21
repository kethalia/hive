"use client";

import { Pause, Play, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useRuntimeConfig } from "@/components/runtime-config-provider";
import { Button } from "@/components/ui/button";
import { terminalProxyHttpBaseUrl } from "@/hooks/useKeepAliveStatus";
import {
  parseTerminalSessionEventPayload,
  type TerminalSessionEvent,
  type TerminalSessionEventPayload,
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

interface SessionEventLogState {
  events: TerminalSessionEvent[];
  paused: boolean;
  setPaused: Dispatch<SetStateAction<boolean>>;
  error: string | null;
  lastUpdatedAt: string | null;
  refresh: (replace?: boolean) => Promise<void>;
}

function formatDetails(event: TerminalSessionEvent): string {
  return Object.entries(event.details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString().slice(11, 23);
}

async function fetchSessionEvents(
  endpoint: string,
  workspaceId: string | undefined,
  afterId: number,
): Promise<TerminalSessionEventPayload> {
  const params = new URLSearchParams({ limit: String(MAX_RENDERED_EVENTS) });
  if (workspaceId) params.set("workspaceId", workspaceId);
  if (afterId > 0) params.set("after", String(afterId));
  const response = await fetch(`${endpoint}?${params.toString()}`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = parseTerminalSessionEventPayload(await response.json());
  if (!payload) throw new Error("Malformed terminal event response");
  return payload;
}

function mergeEvents(
  current: TerminalSessionEvent[],
  incoming: TerminalSessionEvent[],
  replace: boolean,
): TerminalSessionEvent[] {
  const next = replace ? incoming : [...current, ...incoming];
  const unique = new Map(next.map((event) => [event.id, event]));
  return [...unique.values()].slice(-MAX_RENDERED_EVENTS);
}

function eventRefreshErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Event refresh failed";
}

function nextEventId(
  events: TerminalSessionEvent[],
  instanceChanged: boolean,
  currentId: number,
): number {
  const receivedId = events.at(-1)?.id;
  if (receivedId !== undefined) return receivedId;
  return instanceChanged ? 0 : currentId;
}

function useEventRefresh(
  endpoint: string | null,
  workspaceId: string | undefined,
  mountedRef: RefObject<boolean>,
  instanceIdRef: RefObject<string | null>,
  lastEventIdRef: RefObject<number>,
  setEvents: Dispatch<SetStateAction<TerminalSessionEvent[]>>,
  setError: Dispatch<SetStateAction<string | null>>,
  setLastUpdatedAt: Dispatch<SetStateAction<string | null>>,
) {
  return useCallback(
    async (replace = false) => {
      if (!endpoint) {
        if (mountedRef.current) setError("Terminal proxy event logging is not configured.");
        return;
      }
      try {
        const afterId = replace ? 0 : lastEventIdRef.current;
        const payload = await fetchSessionEvents(endpoint, workspaceId, afterId);
        if (!mountedRef.current) return;
        const instanceChanged = instanceIdRef.current !== payload.instanceId;
        instanceIdRef.current = payload.instanceId;
        setEvents((current) => mergeEvents(current, payload.events, replace || instanceChanged));
        lastEventIdRef.current = nextEventId(
          payload.events,
          instanceChanged,
          lastEventIdRef.current,
        );
        setError(null);
        setLastUpdatedAt(payload.generatedAt);
      } catch (refreshError) {
        if (!mountedRef.current) return;
        setError(eventRefreshErrorMessage(refreshError));
      }
    },
    [
      endpoint,
      workspaceId,
      mountedRef,
      instanceIdRef,
      lastEventIdRef,
      setEvents,
      setError,
      setLastUpdatedAt,
    ],
  );
}

function useResetEventLog(
  refresh: (replace?: boolean) => Promise<void>,
  mountedRef: RefObject<boolean>,
  instanceIdRef: RefObject<string | null>,
  lastEventIdRef: RefObject<number>,
  setEvents: Dispatch<SetStateAction<TerminalSessionEvent[]>>,
) {
  useEffect(() => {
    mountedRef.current = true;
    instanceIdRef.current = null;
    lastEventIdRef.current = 0;
    setEvents([]);
    void refresh(true);
    return () => {
      mountedRef.current = false;
    };
  }, [refresh, mountedRef, instanceIdRef, lastEventIdRef, setEvents]);
}

function useEventPolling(paused: boolean, refresh: (replace?: boolean) => Promise<void>) {
  useEffect(() => {
    if (paused) return;
    const intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [paused, refresh]);
}

function useSessionEventLog(endpoint: string | null, workspaceId?: string): SessionEventLogState {
  const [events, setEvents] = useState<TerminalSessionEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const instanceIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const refresh = useEventRefresh(
    endpoint,
    workspaceId,
    mountedRef,
    instanceIdRef,
    lastEventIdRef,
    setEvents,
    setError,
    setLastUpdatedAt,
  );
  useResetEventLog(refresh, mountedRef, instanceIdRef, lastEventIdRef, setEvents);
  useEventPolling(paused, refresh);

  return { events, paused, setPaused, error, lastUpdatedAt, refresh };
}

function SessionEventLogHeader({
  sessionName,
  workspaceId,
  eventCount,
  paused,
  setPaused,
  onRefresh,
}: Pick<TerminalSessionEventLogProps, "sessionName" | "workspaceId"> & {
  eventCount: number;
  paused: boolean;
  setPaused: Dispatch<SetStateAction<boolean>>;
  onRefresh: () => void;
}) {
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-white/10 px-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
        {sessionName ? `session=${sessionName}` : `workspace=${workspaceId ?? "all"}`}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-zinc-500">{eventCount} events</span>
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
        onClick={onRefresh}
      >
        <RefreshCw className="size-3" />
      </Button>
    </div>
  );
}

function SessionEventRows({ events }: { events: TerminalSessionEvent[] }) {
  if (events.length === 0)
    return <p className="p-3 text-zinc-500">No session events recorded yet.</p>;
  return (
    <ol className="min-w-max p-2">
      {events.map((event) => (
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
  );
}

function SessionEventLogBody({
  events,
  compact,
  scrollRef,
}: {
  events: TerminalSessionEvent[];
  compact: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  return (
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
      <SessionEventRows events={events} />
    </div>
  );
}

function SessionEventLogFooter({
  compact,
  lastUpdatedAt,
}: {
  compact: boolean;
  lastUpdatedAt: string | null;
}) {
  if (compact) return null;
  return (
    <p className="shrink-0 border-t border-white/10 px-2 py-1 text-[10px] text-zinc-500">
      Sanitized metadata only—command input, terminal output, tokens, proofs, and paths are never
      recorded. Last updated {lastUpdatedAt ?? "—"}.
    </p>
  );
}

export function TerminalSessionEventLog({
  workspaceId,
  sessionName,
  className,
  compact = false,
}: TerminalSessionEventLogProps) {
  const { terminalWsUrl } = useRuntimeConfig();
  const endpoint = useMemo(
    () => (terminalWsUrl ? `${terminalProxyHttpBaseUrl(terminalWsUrl)}/session-events` : null),
    [terminalWsUrl],
  );
  const { events, paused, setPaused, error, lastUpdatedAt, refresh } = useSessionEventLog(
    endpoint,
    workspaceId,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

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
      <SessionEventLogHeader
        sessionName={sessionName}
        workspaceId={workspaceId}
        eventCount={visibleEvents.length}
        paused={paused}
        setPaused={setPaused}
        onRefresh={() => void refresh(true)}
      />
      {error ? (
        <p className="border-b border-red-500/30 bg-red-500/10 px-2 py-1 font-mono text-[11px] text-red-300">
          event stream unavailable: {error}
        </p>
      ) : null}
      <SessionEventLogBody events={visibleEvents} compact={compact} scrollRef={scrollRef} />
      <SessionEventLogFooter compact={compact} lastUpdatedAt={lastUpdatedAt} />
    </section>
  );
}
