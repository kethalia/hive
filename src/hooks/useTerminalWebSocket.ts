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

export type TerminalCloseReasonCategory =
  | "none"
  | "auth-expired"
  | "permission-denied"
  | "clone-proof-invalid"
  | "workspace-offline"
  | "upstream-timeout"
  | "upstream-error"
  | "timeout"
  | "unknown";

export type TerminalRecoveryFailureCategory =
  | "auth-expired"
  | "permission-denied"
  | "clone-proof-invalid"
  | "terminal-closed"
  | "unknown-final-failure";

export type TerminalCloseCategory =
  | "transient"
  | "workspace-offline"
  | "auth-expired"
  | "permission-denied"
  | "clone-proof-invalid"
  | "terminal-closed"
  | "unknown-final-failure";

export type TerminalRecoveryPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "recovering"
  | "workspace-offline"
  | "final-failure";

export type TerminalRecoveryAction =
  | "none"
  | "initial-connect"
  | "schedule-reconnect"
  | "manual-reconnect"
  | "connected";

export type TerminalRefreshAction =
  | "none"
  | "refresh-before-reconnect"
  | "refresh-succeeded"
  | "refresh-failed";

export type TerminalRefreshFailureCategory =
  | "callback-error"
  | "malformed-response"
  | "malformed-identity"
  | "session-name-mismatch";

export type TerminalReconnectReason = "scheduled-reconnect" | "manual-reconnect";

export type TerminalRefreshUrlFailure = {
  failureCategory: TerminalRefreshFailureCategory;
};

export type TerminalRefreshUrlResult = string | TerminalRefreshUrlFailure | null | undefined;

export type TerminalRefreshUrlContext = {
  currentUrl: string;
  reason: TerminalReconnectReason;
  retryCount: number;
  closeCode: number | null;
  closeCategory: TerminalCloseCategory | null;
  reasonCategory: TerminalCloseReasonCategory | null;
};

export type TerminalRefreshUrlBeforeReconnect = (
  context: TerminalRefreshUrlContext,
) => Promise<TerminalRefreshUrlResult> | TerminalRefreshUrlResult;

export type TerminalCloseClassification = {
  closeCategory: TerminalCloseCategory;
  reasonCategory: TerminalCloseReasonCategory;
  failureCategory: TerminalRecoveryFailureCategory | null;
  recoverable: boolean;
};

export type TerminalRecoveryState = {
  phase: TerminalRecoveryPhase;
  retryCount: number;
  maxRetryCount: number | null;
  lastCloseCode: number | null;
  lastCloseCategory: TerminalCloseCategory | null;
  lastReasonCategory: TerminalCloseReasonCategory | null;
  failureCategory: TerminalRecoveryFailureCategory | null;
  lastDelayMs: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastRecoveryAction: TerminalRecoveryAction;
  lastRefreshAction: TerminalRefreshAction;
  refreshFailureCategory: TerminalRefreshFailureCategory | null;
  lastRefreshStartedAt: number | null;
  lastRefreshFinishedAt: number | null;
  isRecoverable: boolean;
  canRetry: boolean;
};

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const BACKOFF_FACTOR = 2;
const JITTER_MS = 500;
const FOREGROUND_RECONNECT_AFTER_MS = 10000;
const CONNECTING_STALL_MS = 15000;
const WORKSPACE_OFFLINE_CODE = 4404;
const AUTH_EXPIRED_CODE = 4401;
const PERMISSION_DENIED_CODE = 4403;

const INITIAL_RECOVERY_STATE: TerminalRecoveryState = {
  phase: "idle",
  retryCount: 0,
  maxRetryCount: null,
  lastCloseCode: null,
  lastCloseCategory: null,
  lastReasonCategory: null,
  failureCategory: null,
  lastDelayMs: null,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastRecoveryAction: "none",
  lastRefreshAction: "none",
  refreshFailureCategory: null,
  lastRefreshStartedAt: null,
  lastRefreshFinishedAt: null,
  isRecoverable: true,
  canRetry: false,
};

export function computeBackoff(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** attempt, MAX_DELAY_MS);
  const jitter = (Math.random() - 0.5) * 2 * JITTER_MS;
  return Math.min(MAX_DELAY_MS, Math.max(0, exponential + jitter));
}

function sanitizeCloseCode(code: number): number | null {
  if (!Number.isInteger(code) || code < 0 || code > 4999) return null;
  return code;
}

function categorizeCloseReason(reason: string): TerminalCloseReasonCategory {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return "none";
  if (normalized.includes("cloneproof")) return "clone-proof-invalid";
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("no_cookie") ||
    normalized.includes("invalid_hmac") ||
    normalized.includes("session_not_found") ||
    normalized.includes("token_not_found") ||
    normalized.includes("auth")
  ) {
    return "auth-expired";
  }
  if (normalized.includes("forbidden") || normalized.includes("permission")) {
    return "permission-denied";
  }
  if (normalized.includes("workspace") && normalized.includes("offline")) {
    return "workspace-offline";
  }
  if (normalized.includes("upstream connect timeout")) return "upstream-timeout";
  if (normalized.includes("upstream error")) return "upstream-error";
  if (normalized.includes("timeout")) return "timeout";
  return "unknown";
}

export function classifyTerminalClose(
  event: Pick<CloseEvent, "code" | "reason" | "wasClean">,
): TerminalCloseClassification {
  const reasonCategory = categorizeCloseReason(event.reason);

  if (event.code === WORKSPACE_OFFLINE_CODE || reasonCategory === "workspace-offline") {
    return {
      closeCategory: "workspace-offline",
      reasonCategory,
      failureCategory: null,
      recoverable: true,
    };
  }

  if (event.code === AUTH_EXPIRED_CODE || reasonCategory === "auth-expired") {
    return {
      closeCategory: "auth-expired",
      reasonCategory,
      failureCategory: "auth-expired",
      recoverable: false,
    };
  }

  if (event.code === PERMISSION_DENIED_CODE || reasonCategory === "permission-denied") {
    return {
      closeCategory: "permission-denied",
      reasonCategory,
      failureCategory: "permission-denied",
      recoverable: false,
    };
  }

  if (reasonCategory === "clone-proof-invalid") {
    return {
      closeCategory: "clone-proof-invalid",
      reasonCategory,
      failureCategory: "clone-proof-invalid",
      recoverable: false,
    };
  }

  if (event.wasClean && event.code === 1000) {
    return {
      closeCategory: "terminal-closed",
      reasonCategory,
      failureCategory: "terminal-closed",
      recoverable: false,
    };
  }

  return {
    closeCategory: "transient",
    reasonCategory,
    failureCategory: null,
    recoverable: true,
  };
}

export type TerminalResizeSentEvent = {
  rows: number;
  cols: number;
  source: string;
  sentAt: number;
};

interface UseTerminalWebSocketProps {
  url: string | null;
  onData: (data: Uint8Array | string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onResizeSent?: (event: TerminalResizeSentEvent) => void;
  onRecoveryStateChange?: (state: TerminalRecoveryState) => void;
  refreshUrlBeforeReconnect?: TerminalRefreshUrlBeforeReconnect;
}

interface UseTerminalWebSocketReturn {
  send: (data: string) => void;
  resize: (rows: number, cols: number, source?: string) => void;
  connectionState: ConnectionState;
  recoveryState: TerminalRecoveryState;
  manualReconnect: () => void;
}

type RecoveryStateUpdate =
  | TerminalRecoveryState
  | ((current: TerminalRecoveryState) => TerminalRecoveryState);

type ConnectOptions = {
  recoveryAction?: TerminalRecoveryAction;
  reconnectReason?: TerminalReconnectReason;
  refreshBeforeConnect?: boolean;
  generation?: number;
};

type MutableRef<T> = {
  current: T;
};

type StartManualReconnectOptions = {
  preserveRetryCount?: boolean;
};

type UseBrowserLifecycleReconnectionOptions = {
  backgroundedAtRef: MutableRef<number | null>;
  connectionStateRef: MutableRef<ConnectionState>;
  getSocket: () => WebSocket | null;
  startManualReconnect: (options?: StartManualReconnectOptions) => void;
};

function normalizeResizeDimension(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function isTerminalRefreshFailure(value: unknown): value is TerminalRefreshUrlFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const category = (value as { failureCategory?: unknown }).failureCategory;
  return (
    category === "callback-error" ||
    category === "malformed-response" ||
    category === "malformed-identity" ||
    category === "session-name-mismatch"
  );
}

function useBrowserLifecycleReconnection({
  backgroundedAtRef,
  connectionStateRef,
  getSocket,
  startManualReconnect,
}: UseBrowserLifecycleReconnectionOptions) {
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const handleBackground = () => {
      backgroundedAtRef.current = Date.now();
    };

    const handleForeground = ({ persisted = false }: { persisted?: boolean } = {}) => {
      const backgroundedAt = backgroundedAtRef.current;
      backgroundedAtRef.current = null;

      const state = connectionStateRef.current;
      const shouldReconnectState =
        state === "connected" ||
        state === "connecting" ||
        state === "reconnecting" ||
        state === "disconnected";
      if (!shouldReconnectState) return;

      const hiddenDuration = backgroundedAt === null ? null : Date.now() - backgroundedAt;
      const hasOpenSocket = getSocket()?.readyState === WebSocket.OPEN;
      if (
        !persisted &&
        hasOpenSocket &&
        (hiddenDuration === null || hiddenDuration < FOREGROUND_RECONNECT_AFTER_MS)
      ) {
        return;
      }

      startManualReconnect({ preserveRetryCount: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        handleBackground();
      } else {
        handleForeground();
      }
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (document.visibilityState !== "hidden") {
        handleForeground({ persisted: event.persisted });
      }
    };

    const handleOnline = () => {
      if (connectionStateRef.current !== "connected") {
        startManualReconnect({ preserveRetryCount: true });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handleBackground);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handleBackground);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
    };
  }, [backgroundedAtRef, connectionStateRef, getSocket, startManualReconnect]);
}

export function useTerminalWebSocket({
  url,
  onData,
  onStateChange,
  onResizeSent,
  onRecoveryStateChange,
  refreshUrlBeforeReconnect,
}: UseTerminalWebSocketProps): UseTerminalWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [recoveryState, setRecoveryState] = useState<TerminalRecoveryState>(INITIAL_RECOVERY_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingStallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  const connectionGenerationRef = useRef(0);
  const currentUrlRef = useRef<string | null>(url);
  const connectionStateRef = useRef<ConnectionState>("disconnected");
  const recoveryStateRef = useRef<TerminalRecoveryState>(INITIAL_RECOVERY_STATE);
  const backgroundedAtRef = useRef<number | null>(null);
  const onDataRef = useRef(onData);
  const onStateChangeRef = useRef(onStateChange);
  const onResizeSentRef = useRef(onResizeSent);
  const onRecoveryStateChangeRef = useRef(onRecoveryStateChange);
  const refreshUrlBeforeReconnectRef = useRef(refreshUrlBeforeReconnect);

  onDataRef.current = onData;
  onStateChangeRef.current = onStateChange;
  onResizeSentRef.current = onResizeSent;
  onRecoveryStateChangeRef.current = onRecoveryStateChange;
  refreshUrlBeforeReconnectRef.current = refreshUrlBeforeReconnect;

  const updateRecoveryState = useCallback((update: RecoveryStateUpdate) => {
    if (!mountedRef.current) return;
    const next = typeof update === "function" ? update(recoveryStateRef.current) : update;
    recoveryStateRef.current = next;
    setRecoveryState(next);
    onRecoveryStateChangeRef.current?.(next);
  }, []);

  const updateState = useCallback((state: ConnectionState) => {
    if (!mountedRef.current) return;
    connectionStateRef.current = state;
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

  const clearConnectingStallTimer = useCallback(() => {
    if (connectingStallTimerRef.current !== null) {
      clearTimeout(connectingStallTimerRef.current);
      connectingStallTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(
    async ({
      recoveryAction,
      reconnectReason,
      refreshBeforeConnect = false,
      generation = connectionGenerationRef.current,
    }: ConnectOptions = {}) => {
      const baseUrl = currentUrlRef.current ?? url;
      if (!baseUrl || !mountedRef.current) return;

      clearReconnectTimer();
      clearConnectingStallTimer();

      const action: TerminalRecoveryAction =
        recoveryAction ?? (attemptRef.current > 0 ? "schedule-reconnect" : "initial-connect");
      const isReconnect = action !== "initial-connect" || attemptRef.current > 0;
      let effectiveUrl = baseUrl;

      const scheduleRefreshFailureRetry = (failureCategory: TerminalRefreshFailureCategory) => {
        if (!mountedRef.current || generation !== connectionGenerationRef.current) return;

        const delay = computeBackoff(attemptRef.current);
        attemptRef.current += 1;
        const retryCount = attemptRef.current;
        const finishedAt = Date.now();

        updateState("disconnected");
        updateRecoveryState((current) => ({
          ...current,
          phase: "recovering",
          retryCount,
          failureCategory: null,
          lastDelayMs: Math.round(delay),
          lastRecoveryAction: action,
          lastRefreshAction: "refresh-failed",
          refreshFailureCategory: failureCategory,
          lastRefreshFinishedAt: finishedAt,
          isRecoverable: true,
          canRetry: true,
        }));
        console.log(
          `[terminal] Reconnect URL refresh failed category=${failureCategory}; reconnecting in ${Math.round(delay)}ms`,
        );
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generation === connectionGenerationRef.current) {
            void connect({
              recoveryAction: "schedule-reconnect",
              reconnectReason: "scheduled-reconnect",
              refreshBeforeConnect: true,
              generation,
            });
          }
        }, delay);
      };

      if (refreshBeforeConnect && refreshUrlBeforeReconnectRef.current) {
        const startedAt = Date.now();
        updateState("reconnecting");
        updateRecoveryState((current) => ({
          ...current,
          phase: "recovering",
          lastRecoveryAction: action,
          lastRefreshAction: "refresh-before-reconnect",
          refreshFailureCategory: null,
          lastRefreshStartedAt: startedAt,
          lastRefreshFinishedAt: null,
          isRecoverable: true,
          canRetry: false,
        }));

        let refreshedUrl: TerminalRefreshUrlResult;
        try {
          refreshedUrl = await refreshUrlBeforeReconnectRef.current({
            currentUrl: baseUrl,
            reason: reconnectReason ?? "scheduled-reconnect",
            retryCount: recoveryStateRef.current.retryCount,
            closeCode: recoveryStateRef.current.lastCloseCode,
            closeCategory: recoveryStateRef.current.lastCloseCategory,
            reasonCategory: recoveryStateRef.current.lastReasonCategory,
          });
        } catch {
          scheduleRefreshFailureRetry("callback-error");
          return;
        }

        if (isTerminalRefreshFailure(refreshedUrl)) {
          scheduleRefreshFailureRetry(refreshedUrl.failureCategory);
          return;
        }

        if (typeof refreshedUrl !== "string" || refreshedUrl.trim().length === 0) {
          scheduleRefreshFailureRetry("malformed-response");
          return;
        }

        if (!mountedRef.current || generation !== connectionGenerationRef.current) return;

        effectiveUrl = refreshedUrl;
        currentUrlRef.current = refreshedUrl;
        updateRecoveryState((current) => ({
          ...current,
          lastRefreshAction: "refresh-succeeded",
          refreshFailureCategory: null,
          lastRefreshFinishedAt: Date.now(),
          isRecoverable: true,
          canRetry: false,
        }));
      }

      if (!mountedRef.current || generation !== connectionGenerationRef.current) return;

      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      updateState(isReconnect ? "reconnecting" : "connecting");
      updateRecoveryState((current) => ({
        ...current,
        phase: isReconnect ? "recovering" : "connecting",
        lastRecoveryAction: action,
        canRetry: false,
        isRecoverable: true,
      }));
      if (isReconnect) {
        console.log(`[terminal] Reconnect attempt ${attemptRef.current}`);
      }

      const ws = new WebSocket(effectiveUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close();
          return;
        }
        clearConnectingStallTimer();
        attemptRef.current = 0;
        updateState("connected");
        updateRecoveryState((current) => ({
          ...current,
          phase: "connected",
          retryCount: 0,
          failureCategory: null,
          lastDelayMs: null,
          lastConnectedAt: Date.now(),
          lastRecoveryAction: "connected",
          isRecoverable: true,
          canRetry: false,
        }));
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
        clearConnectingStallTimer();
        wsRef.current = null;

        const classification = classifyTerminalClose(event);
        const closeCode = sanitizeCloseCode(event.code);
        const disconnectedAt = Date.now();
        const canRefreshCloneProof =
          classification.closeCategory === "clone-proof-invalid" &&
          Boolean(refreshUrlBeforeReconnectRef.current);

        if (!classification.recoverable && !canRefreshCloneProof) {
          updateState("failed");
          updateRecoveryState((current) => ({
            ...current,
            phase: "final-failure",
            lastCloseCode: closeCode,
            lastCloseCategory: classification.closeCategory,
            lastReasonCategory: classification.reasonCategory,
            failureCategory: classification.failureCategory,
            lastDelayMs: null,
            lastDisconnectedAt: disconnectedAt,
            lastRecoveryAction: "none",
            isRecoverable: false,
            canRetry: true,
          }));
          console.log(
            `[terminal] Final WebSocket close category=${classification.closeCategory} code=${closeCode ?? "unknown"}`,
          );
          return;
        }

        const delay = computeBackoff(attemptRef.current);
        attemptRef.current += 1;
        const retryCount = attemptRef.current;
        const reconnectGeneration = connectionGenerationRef.current;

        updateState(
          classification.closeCategory === "workspace-offline"
            ? "workspace-offline"
            : "disconnected",
        );
        updateRecoveryState((current) => ({
          ...current,
          phase:
            classification.closeCategory === "workspace-offline"
              ? "workspace-offline"
              : "recovering",
          retryCount,
          lastCloseCode: closeCode,
          lastCloseCategory: classification.closeCategory,
          lastReasonCategory: classification.reasonCategory,
          failureCategory: null,
          lastDelayMs: Math.round(delay),
          lastDisconnectedAt: disconnectedAt,
          lastRecoveryAction: "schedule-reconnect",
          isRecoverable: true,
          canRetry: true,
        }));
        console.log(
          `[terminal] Recoverable WebSocket close category=${classification.closeCategory} code=${closeCode ?? "unknown"}; reconnecting in ${Math.round(delay)}ms`,
        );
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && reconnectGeneration === connectionGenerationRef.current) {
            void connect({
              recoveryAction: "schedule-reconnect",
              reconnectReason: "scheduled-reconnect",
              refreshBeforeConnect: Boolean(refreshUrlBeforeReconnectRef.current),
              generation: reconnectGeneration,
            });
          }
        }, delay);
      };

      ws.onerror = () => {
        console.log("[terminal] WebSocket error");
      };

      connectingStallTimerRef.current = setTimeout(() => {
        if (
          !mountedRef.current ||
          generation !== connectionGenerationRef.current ||
          wsRef.current !== ws ||
          ws.readyState === WebSocket.OPEN
        ) {
          return;
        }

        console.log("[terminal] WebSocket connection stalled; forcing reconnect");
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;

        const delay = computeBackoff(attemptRef.current);
        attemptRef.current += 1;
        const retryCount = attemptRef.current;
        updateState("disconnected");
        updateRecoveryState((current) => ({
          ...current,
          phase: "recovering",
          retryCount,
          lastCloseCode: null,
          lastCloseCategory: "transient",
          lastReasonCategory: "timeout",
          failureCategory: null,
          lastDelayMs: Math.round(delay),
          lastDisconnectedAt: Date.now(),
          lastRecoveryAction: "schedule-reconnect",
          isRecoverable: true,
          canRetry: true,
        }));
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generation === connectionGenerationRef.current) {
            void connect({
              recoveryAction: "schedule-reconnect",
              reconnectReason: "scheduled-reconnect",
              refreshBeforeConnect: Boolean(refreshUrlBeforeReconnectRef.current),
              generation,
            });
          }
        }, delay);
      }, CONNECTING_STALL_MS);
    },
    [url, updateState, updateRecoveryState, clearReconnectTimer, clearConnectingStallTimer],
  );

  useEffect(() => {
    mountedRef.current = true;
    connectionGenerationRef.current += 1;
    const generation = connectionGenerationRef.current;
    currentUrlRef.current = url;
    attemptRef.current = 0;
    recoveryStateRef.current = INITIAL_RECOVERY_STATE;
    connectionStateRef.current = "disconnected";
    setRecoveryState(INITIAL_RECOVERY_STATE);
    void connect({ recoveryAction: "initial-connect", refreshBeforeConnect: false, generation });

    return () => {
      mountedRef.current = false;
      connectionGenerationRef.current += 1;
      clearReconnectTimer();
      clearConnectingStallTimer();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearReconnectTimer, clearConnectingStallTimer, url]);

  const startManualReconnect = useCallback(
    ({ preserveRetryCount = false }: StartManualReconnectOptions = {}) => {
      if (!(currentUrlRef.current ?? url) || !mountedRef.current) return;
      const recovery = recoveryStateRef.current;
      if (recovery.phase === "final-failure" && recovery.isRecoverable === false) return;

      connectionGenerationRef.current += 1;
      const generation = connectionGenerationRef.current;
      clearReconnectTimer();
      clearConnectingStallTimer();
      attemptRef.current = preserveRetryCount ? Math.max(attemptRef.current, 1) : 0;
      updateRecoveryState((current) => ({
        ...current,
        phase: "recovering",
        retryCount: preserveRetryCount ? Math.max(current.retryCount, 1) : 0,
        lastDelayMs: null,
        lastRecoveryAction: "manual-reconnect",
        isRecoverable: true,
        canRetry: false,
      }));
      void connect({
        recoveryAction: "manual-reconnect",
        reconnectReason: "manual-reconnect",
        refreshBeforeConnect: Boolean(refreshUrlBeforeReconnectRef.current),
        generation,
      });
    },
    [url, connect, updateRecoveryState, clearReconnectTimer, clearConnectingStallTimer],
  );

  const manualReconnect = useCallback(() => {
    startManualReconnect();
  }, [startManualReconnect]);

  const getSocket = useCallback(() => wsRef.current, []);

  useBrowserLifecycleReconnection({
    backgroundedAtRef,
    connectionStateRef,
    getSocket,
    startManualReconnect,
  });

  const send = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const resize = useCallback((rows: number, cols: number, source = "unknown") => {
    const normalizedRows = normalizeResizeDimension(rows);
    const normalizedCols = normalizeResizeDimension(cols);
    if (normalizedRows === null || normalizedCols === null) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encodeResize(normalizedRows, normalizedCols));
      onResizeSentRef.current?.({
        rows: normalizedRows,
        cols: normalizedCols,
        source,
        sentAt: Date.now(),
      });
    }
  }, []);

  return { send, connectionState, resize, recoveryState, manualReconnect };
}
