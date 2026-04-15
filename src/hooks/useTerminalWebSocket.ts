"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeResize } from "@/lib/terminal/protocol";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "failed"
  | "workspace-offline";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;
const BACKOFF_FACTOR = 2;
const JITTER_MS = 500;
const WORKSPACE_OFFLINE_CODE = 4404;

export function computeBackoff(attempt: number): number {
  const exponential = Math.min(
    BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt),
    MAX_DELAY_MS,
  );
  const jitter = (Math.random() - 0.5) * 2 * JITTER_MS;
  return Math.max(0, exponential + jitter);
}

const CONSECUTIVE_FAILURE_THRESHOLD = 3;

interface UseTerminalWebSocketProps {
  url: string | null;
  onData: (data: Uint8Array | string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onReconnectIdExpired?: () => void;
}

interface UseTerminalWebSocketReturn {
  send: (data: string) => void;
  resize: (rows: number, cols: number) => void;
  connectionState: ConnectionState;
  reconnectAttempt: number;
  consecutiveFailures: number;
  reconnect: () => void;
}

export function useTerminalWebSocket({
  url,
  onData,
  onStateChange,
  onReconnectIdExpired,
}: UseTerminalWebSocketProps): UseTerminalWebSocketReturn {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  const consecutiveFailuresRef = useRef(0);
  const openedRef = useRef(false);
  const onDataRef = useRef(onData);
  const onStateChangeRef = useRef(onStateChange);
  const onReconnectIdExpiredRef = useRef(onReconnectIdExpired);

  onDataRef.current = onData;
  onStateChangeRef.current = onStateChange;
  onReconnectIdExpiredRef.current = onReconnectIdExpired;

  const updateState = useCallback((state: ConnectionState) => {
    if (!mountedRef.current) return;
    setConnectionState(state);
    onStateChangeRef.current?.(state);
    console.log(`[terminal] Connection state: ${state}`);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!url || !mountedRef.current) return;

    clearReconnectTimer();

    const isReconnect = attemptRef.current > 0;
    updateState(isReconnect ? "reconnecting" : "connecting");
    if (isReconnect) {
      console.log(
        `[terminal] Reconnect attempt ${attemptRef.current}`,
      );
    }

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    openedRef.current = false;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      openedRef.current = true;
      attemptRef.current = 0;
      setReconnectAttempt(0);
      consecutiveFailuresRef.current = 0;
      updateState("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      if (event.data instanceof ArrayBuffer) {
        onDataRef.current(new Uint8Array(event.data));
      } else {
        onDataRef.current(event.data as string);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (!mountedRef.current) return;
      wsRef.current = null;

      if (event.code === WORKSPACE_OFFLINE_CODE) {
        updateState("workspace-offline");
        console.log(
          `[terminal] Workspace offline (code ${event.code}): ${event.reason}`,
        );
        return;
      }

      if (!openedRef.current) {
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= CONSECUTIVE_FAILURE_THRESHOLD) {
          console.log(
            `[terminal] Regenerating reconnectId after ${consecutiveFailuresRef.current} consecutive failures`,
          );
          consecutiveFailuresRef.current = 0;
          onReconnectIdExpiredRef.current?.();
          return;
        }
      } else {
        consecutiveFailuresRef.current = 0;
      }

      updateState("disconnected");
      const delay = computeBackoff(attemptRef.current);
      attemptRef.current += 1;
      setReconnectAttempt(attemptRef.current);
      console.log(`[terminal] Reconnecting in ${Math.round(delay)}ms`);
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };

    ws.onerror = () => {
      console.log("[terminal] WebSocket error");
    };
  }, [url, updateState, clearReconnectTimer]);

  useEffect(() => {
    mountedRef.current = true;
    attemptRef.current = 0;
    connect();

    return () => {
      mountedRef.current = false;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearReconnectTimer]);

  const send = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const resize = useCallback((rows: number, cols: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encodeResize(rows, cols));
    }
  }, []);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    connect();
  }, [connect]);

  return { send, connectionState, resize, reconnectAttempt: attemptRef.current, consecutiveFailures: consecutiveFailuresRef.current, reconnect };
}
