"use client";

import { useCallback, useEffect, useState } from "react";
import { CodexSessionAdapter, type SessionView } from "@/lib/codex-session/adapter";
import {
  openCodexSessionTransport,
  type SessionGrant,
  SessionTransportError,
} from "@/lib/codex-session/browser-transport";

const initial: SessionView = { phase: "loading", turns: [], needsRefresh: true, error: null };
class SessionDenied extends Error {}

/** One read connection per mounted project. Reconnect only reauthorizes and loads
 * history: no API here can create a thread, attach a CLI or submit a prompt. */
export function useProjectConversation(projectId: string, enabled: boolean) {
  const [view, setView] = useState<SessionView>(initial);
  const [generation, setGeneration] = useState(0);
  const reconnect = useCallback(() => setGeneration((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation explicitly requests a fresh authorized connection.
  useEffect(() => {
    if (!enabled) {
      setView({ ...initial, phase: "disconnected", needsRefresh: false });
      return;
    }
    let disposed = false;
    let adapter: CodexSessionAdapter | undefined;
    let stopClose: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let connecting = false;
    const controller = new AbortController();
    const freshGrant = async (): Promise<SessionGrant> => {
      const response = await fetch(`/api/projects/${projectId}/session-grant`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) throw new SessionDenied();
        throw new Error("Session authorization unavailable");
      }
      return response.json();
    };
    const schedule = () => {
      if (disposed || retries >= 3 || retryTimer) return;
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          void connect();
        },
        1000 * 2 ** retries++,
      );
    };
    const connect = async () => {
      if (disposed || connecting) return;
      connecting = true;
      stopClose?.();
      adapter?.disconnect();
      try {
        const grant = await freshGrant();
        if (disposed) return;
        const transport = await openCodexSessionTransport(grant, { freshGrant });
        if (disposed) {
          transport.close();
          return;
        }
        adapter = new CodexSessionAdapter(grant.binding, (next) => {
          if (!disposed) setView(next);
        });
        stopClose = transport.onClose((reason) => {
          if (reason !== "revoked") schedule();
        });
        await adapter.connect(transport);
      } catch (error) {
        if (disposed) return;
        const revoked =
          error instanceof SessionDenied ||
          (error instanceof SessionTransportError && error.reason === "revoked");
        setView((previous) => ({
          ...previous,
          phase: "error",
          needsRefresh: true,
          error: "Connection unavailable",
          ...(revoked ? { turns: [] } : {}),
        }));
        if (!revoked) schedule();
      } finally {
        connecting = false;
      }
    };
    setView(initial);
    void connect();
    const recover = () => {
      if (document.visibilityState !== "visible" || disposed || connecting) return;
      // A deliberate foreground/online event starts a new bounded retry budget.
      if (adapter?.snapshot.phase === "live") return;
      retries = 0;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      void connect();
    };
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(retryTimer);
      stopClose?.();
      adapter?.disconnect();
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [projectId, enabled, generation]);
  return { view, reconnect };
}
