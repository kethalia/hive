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
const MAX_DELAY_MS = 30000;
const BACKOFF_FACTOR = 2;
const JITTER_MS = 500;
const MAX_RECONNECT_ATTEMPTS = 10;
const WORKSPACE_OFFLINE_CODE = 4404;

export function computeBackoff(attempt: number): number {
  const exponential = Math.min(
    BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt),
    MAX_DELAY_MS,
  );
  const jitter = (Math.random() - 0.5) * 2 * JITTER_MS;
  return Math.max(0, exponential + jitter);
}

interface UseTerminalWebSocketProps {
  url: string | null;
  onData: (data: Uint8Array | string) => void;
  onStateChange?: (state: ConnectionState) => void;
}

interface UseTerminalWebSocketReturn {
  send: (data: string) => void;
  resize: (rows: number, cols: number) => void;
  connectionState: ConnectionState;
}

export function useTerminalWebSocket({
  url,
  onData,
  onStateChange,
}: UseTerminalWebSocketProps): UseTerminalWebSocketReturn {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  const onDataRef = useRef(onData);
  const onStateChangeRef = useRef(onStateChange);

  onDataRef.current = onData;
  onStateChangeRef.current = onStateChange;

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

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const isReconnect = attemptRef.current > 0;
    updateState(isReconnect ? "reconnecting" : "connecting");
    if (isReconnect) {
      console.log(
        `[terminal] Reconnect attempt ${attemptRef.current}/${MAX_RECONNECT_ATTEMPTS}`,
      );
    }

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      attemptRef.current = 0;
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

      if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        updateState("failed");
        console.log(
          `[terminal] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`,
        );
        return;
      }

      updateState("disconnected");
      const delay = computeBackoff(attemptRef.current);
      attemptRef.current += 1;
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

  return { send, connectionState, resize };
}
