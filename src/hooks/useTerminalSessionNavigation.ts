"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { filterGenericTmuxSessions, type TmuxSession } from "@/lib/workspaces/sessions";

export interface TerminalSessionNavigationState {
  sessions: TmuxSession[];
  current: TmuxSession | null;
  previous: TmuxSession | null;
  next: TmuxSession | null;
  canGoPrevious: boolean;
  canGoNext: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
  select: (sessionName: string) => boolean;
}

function terminalSessionNavigationHref(
  workspaceId: string,
  sessionName: string,
  debugViewportEnabled: boolean,
): string {
  const href = `/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(sessionName)}`;
  return debugViewportEnabled ? `${href}&debugViewport=1` : href;
}

function isTmuxSession(value: unknown): value is TmuxSession {
  if (!value || typeof value !== "object") return false;

  const name = Reflect.get(value, "name");
  const created = Reflect.get(value, "created");
  const windows = Reflect.get(value, "windows");

  return (
    typeof name === "string" &&
    name.length > 0 &&
    typeof created === "number" &&
    Number.isFinite(created) &&
    typeof windows === "number" &&
    Number.isFinite(windows)
  );
}

function normalizeSessions(value: unknown): TmuxSession[] {
  if (!Array.isArray(value)) {
    throw new Error("Terminal session response was malformed");
  }

  return filterGenericTmuxSessions(value.filter(isTmuxSession));
}

export function useTerminalSessionNavigation(workspaceId: string): TerminalSessionNavigationState {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSessionName = searchParams.get("session");
  const debugViewportEnabled = searchParams.get("debugViewport") === "1";
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // The reload key intentionally retriggers this route-authoritative list action.
    void reloadKey;

    if (!activeSessionName) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function loadSessions() {
      try {
        const result = await getWorkspaceSessionsAction({ workspaceId });
        if (cancelled) return;

        if (result?.serverError) {
          setSessions([]);
          setError(result.serverError);
          return;
        }

        if (!result || !("data" in result)) {
          setSessions([]);
          setError("Failed to load terminal sessions");
          return;
        }

        setSessions(normalizeSessions(result.data));
      } catch (loadError) {
        if (cancelled) return;
        setSessions([]);
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load terminal sessions",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadSessions();

    return () => {
      cancelled = true;
    };
  }, [activeSessionName, workspaceId, reloadKey]);

  const currentIndex = useMemo(() => {
    if (!activeSessionName) return -1;
    return sessions.findIndex((session) => session.name === activeSessionName);
  }, [activeSessionName, sessions]);

  const current = currentIndex >= 0 ? sessions[currentIndex] : null;
  const previous = currentIndex > 0 ? sessions[currentIndex - 1] : null;
  const next =
    currentIndex >= 0 && currentIndex < sessions.length - 1 ? sessions[currentIndex + 1] : null;
  const validSessionNames = useMemo(
    () => new Set(sessions.map((session) => session.name)),
    [sessions],
  );

  const select = useCallback(
    (sessionName: string) => {
      if (!validSessionNames.has(sessionName)) return false;

      router.replace(terminalSessionNavigationHref(workspaceId, sessionName, debugViewportEnabled));
      return true;
    },
    [debugViewportEnabled, router, validSessionNames, workspaceId],
  );

  const reload = useCallback(() => {
    if (activeSessionName) {
      setReloadKey((value) => value + 1);
    }
  }, [activeSessionName]);

  return {
    sessions,
    current,
    previous,
    next,
    canGoPrevious: previous !== null,
    canGoNext: next !== null,
    loading,
    error,
    reload,
    select,
  };
}
