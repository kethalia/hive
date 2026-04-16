"use client";

import { useEffect, useRef, useState } from "react";

interface KeepAliveStatus {
  consecutiveFailures: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  isLoading: boolean;
}

const POLL_INTERVAL_MS = 30_000;

function wsUrlToHttp(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, "http$1://");
}

export function useKeepAliveStatus(workspaceId: string): KeepAliveStatus {
  const [status, setStatus] = useState<KeepAliveStatus>({
    consecutiveFailures: 0,
    lastSuccess: null,
    lastFailure: null,
    isLoading: true,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const proxyWsUrl = process.env.NEXT_PUBLIC_TERMINAL_WS_URL;
    if (!proxyWsUrl) {
      setStatus((s) => ({ ...s, isLoading: false }));
      return;
    }

    const baseUrl = wsUrlToHttp(proxyWsUrl);

    async function poll() {
      try {
        const res = await fetch(`${baseUrl}/keepalive/status`);
        if (!res.ok) return;
        const json: {
          workspaces: Record<
            string,
            {
              consecutiveFailures: number;
              lastSuccess: string | null;
              lastFailure: string | null;
            }
          >;
        } = await res.json();

        if (!mountedRef.current) return;

        const ws = json.workspaces?.[workspaceId];
        setStatus({
          consecutiveFailures: ws?.consecutiveFailures ?? 0,
          lastSuccess: ws?.lastSuccess ?? null,
          lastFailure: ws?.lastFailure ?? null,
          isLoading: false,
        });
      } catch {
        if (!mountedRef.current) return;
        setStatus((s) => ({ ...s, isLoading: false }));
      }
    }

    void poll();
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [workspaceId]);

  return status;
}
