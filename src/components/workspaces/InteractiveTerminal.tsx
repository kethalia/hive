"use client";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { AlertCircle } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRuntimeConfig } from "@/components/runtime-config-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalPinchZoom } from "@/hooks/useTerminalPinchZoom";
import {
  type ConnectionState,
  type TerminalRecoveryState,
  type TerminalRefreshUrlBeforeReconnect,
  useTerminalWebSocket,
} from "@/hooks/useTerminalWebSocket";
import { useXtermSurface } from "@/hooks/useXtermSurface";
import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import {
  type ClipboardActionStatus,
  dropDataTransferToTerminal,
  pasteClipboardApiToTerminal,
  pasteNativeClipboardEventToTerminal,
} from "@/lib/terminal/actions";
import {
  handleTerminalPasteOutcome,
  readNativePasteOutcome,
  type TerminalComposeRequest,
  type TerminalPasteOutcome,
  type TerminalPasteStatus,
} from "@/lib/terminal/clipboard";
import { EVENT_NAME as FONT_SIZE_EVENT, getTerminalFontSize } from "@/lib/terminal/font-size";
import {
  blurXtermMobileInput,
  configureXtermMobileInput,
  focusTerminalForMobileInput,
  type MobileInputAdapterCleanup,
} from "@/lib/terminal/mobile-input-adapter";
import {
  recordMobileTerminalFit,
  recordMobileTerminalResizeRequest,
  recordMobileTerminalResizeSent,
  recordMobileTerminalXtermDimensions,
} from "@/lib/terminal/mobile-terminal-diagnostics-state";
import { encodeInput } from "@/lib/terminal/protocol";
import { cn } from "@/lib/utils";
import "@/styles/xterm.css";

export interface RefreshedCloneTerminalIdentity {
  sessionName: string;
  clonePath: string;
  cloneProof: string;
}

export interface RefreshCloneTerminalIdentityContext {
  sessionName: string;
  clonePath: string;
  reason: "scheduled-reconnect" | "manual-reconnect";
  retryCount: number;
  closeCode: number | null;
  closeCategory: string | null;
  reasonCategory: string | null;
}

export type RefreshCloneTerminalIdentity = (
  context: RefreshCloneTerminalIdentityContext,
) => Promise<RefreshedCloneTerminalIdentity> | RefreshedCloneTerminalIdentity;

interface InteractiveTerminalProps {
  agentId: string;
  workspaceId: string;
  sessionName: string;
  clonePath?: string;
  cloneProof?: string;
  refreshCloneTerminalIdentity?: RefreshCloneTerminalIdentity;
  className?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onRecoveryStateChange?: (state: TerminalRecoveryState) => void;
  onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
  onTerminalDestroy?: () => void;
  onUserFocusRequest?: () => void;
  onComposeRequest?: (request: TerminalComposeRequest) => void;
  onClipboardStatus?: (status: TerminalPasteStatus) => void;
  targetLabel?: string;
  layoutSignal?: unknown;
  mobileInputMode?: boolean;
  suppressAutoFocus?: boolean;
  pinToBottomOnResize?: boolean;
  selectionModeEnabled?: boolean;
}

interface MobileTouchIntent {
  didScroll: boolean;
  touchIdentifier: number;
  startX: number;
  startY: number;
  lastY: number;
  multiTouch: boolean;
}

const MOBILE_TERMINAL_SCROLL_THRESHOLD_PX = Math.max(TAP_THRESHOLD_PX + 3, 8);
const FALLBACK_TERMINAL_ROWS = 24;
const FALLBACK_TERMINAL_COLS = 80;
const ESC = String.fromCharCode(27);
const XTERM_PRIMARY_DEVICE_ANSWERBACK = `${ESC}[?1;2c`;
const XTERM_SECONDARY_DEVICE_ANSWERBACK_PREFIX = `${ESC}[>0;`;
const XTERM_SECONDARY_DEVICE_ANSWERBACK_SUFFIX = ";0c";

function isTerminalPasteStatus(status: ClipboardActionStatus): status is TerminalPasteStatus {
  return (
    status.action === "paste" &&
    (status.outcome === "empty" ||
      status.outcome === "failed" ||
      status.outcome === "pasted" ||
      status.outcome === "uploading")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTerminalDimension(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.trunc(numeric);
}

function readDimensionFromUrl(url: string, param: "width" | "height", fallback: number): number {
  try {
    return normalizeTerminalDimension(new URL(url).searchParams.get(param), fallback);
  } catch {
    return fallback;
  }
}

function stripXtermDeviceAnswerbacks(data: string): string {
  let filtered = data.split(XTERM_PRIMARY_DEVICE_ANSWERBACK).join("");
  let prefixIndex = filtered.indexOf(XTERM_SECONDARY_DEVICE_ANSWERBACK_PREFIX);

  while (prefixIndex !== -1) {
    const codeStart = prefixIndex + XTERM_SECONDARY_DEVICE_ANSWERBACK_PREFIX.length;
    const suffixIndex = filtered.indexOf(XTERM_SECONDARY_DEVICE_ANSWERBACK_SUFFIX, codeStart);
    if (suffixIndex === -1) break;

    const terminalVersion = filtered.slice(codeStart, suffixIndex);
    if (!/^\d+$/.test(terminalVersion)) {
      prefixIndex = filtered.indexOf(XTERM_SECONDARY_DEVICE_ANSWERBACK_PREFIX, codeStart);
      continue;
    }

    filtered =
      filtered.slice(0, prefixIndex) +
      filtered.slice(suffixIndex + XTERM_SECONDARY_DEVICE_ANSWERBACK_SUFFIX.length);
    prefixIndex = filtered.indexOf(XTERM_SECONDARY_DEVICE_ANSWERBACK_PREFIX, prefixIndex);
  }

  return filtered;
}

function buildTerminalWebSocketUrl({
  proxyUrl,
  agentId,
  workspaceId,
  reconnectId,
  sessionName,
  rows,
  cols,
  clonePath,
  cloneProof,
}: {
  proxyUrl: string;
  agentId: string;
  workspaceId: string;
  reconnectId: string;
  sessionName: string;
  rows: number;
  cols: number;
  clonePath?: string;
  cloneProof?: string;
}): string {
  const params = new URLSearchParams({
    agentId,
    workspaceId,
    reconnectId,
    width: String(cols),
    height: String(rows),
    sessionName,
  });
  if (clonePath) {
    params.set("clonePath", clonePath);
    if (cloneProof) {
      params.set("cloneProof", cloneProof);
    }
  }
  return `${proxyUrl}/ws?${params.toString()}`;
}

function validateRefreshedCloneTerminalIdentity(
  identity: unknown,
  expectedSessionName: string,
): RefreshedCloneTerminalIdentity | "malformed-identity" | "session-name-mismatch" {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return "malformed-identity";
  }

  const candidate = identity as Partial<RefreshedCloneTerminalIdentity>;
  if (!isNonEmptyString(candidate.sessionName)) return "malformed-identity";
  if (candidate.sessionName !== expectedSessionName) return "session-name-mismatch";
  if (!isNonEmptyString(candidate.clonePath) || !isNonEmptyString(candidate.cloneProof)) {
    return "malformed-identity";
  }

  return {
    sessionName: candidate.sessionName,
    clonePath: candidate.clonePath,
    cloneProof: candidate.cloneProof,
  };
}

function preventDefaultIfCancelable(event: { cancelable?: boolean; preventDefault: () => void }) {
  if (event.cancelable) {
    event.preventDefault();
  }
}

function terminalMouseTrackingActive(term: Terminal | null): boolean {
  return term?.modes?.mouseTrackingMode !== undefined && term.modes.mouseTrackingMode !== "none";
}

function nativePasteHasFiles(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items || items.length === 0) return false;

  return Array.from(items).some((item) => item.kind === "file" && Boolean(item.getAsFile()));
}

function dispatchTmuxTouchWheel(
  term: Terminal | null,
  container: HTMLElement | null,
  touch: Pick<Touch, "clientX" | "clientY">,
  deltaY: number,
): boolean {
  if (!terminalMouseTrackingActive(term) || !container) return false;

  const target =
    container.querySelector<HTMLElement>(".xterm-screen") ??
    container.querySelector<HTMLElement>(".xterm") ??
    container;
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: touch.clientX,
    clientY: touch.clientY,
    deltaY: -deltaY,
  });
  target.dispatchEvent(event);
  return true;
}

function warnFitFailure(err: unknown) {
  console.warn("[InteractiveTerminal] fitAddon.fit() failed", err);
}

function safeFit(fit: FitAddon): boolean {
  try {
    fit.fit();
    return true;
  } catch (err) {
    warnFitFailure(err);
    return false;
  }
}

function recordFitDiagnostics(term: Terminal, source: string) {
  recordMobileTerminalFit(term.rows, term.cols, source);
}

function recordResizeRequestDiagnostics(term: Terminal, source: string) {
  recordMobileTerminalResizeRequest(term.rows, term.cols, source);
}

function isTerminalScrolledToBottom(term: Terminal): boolean {
  const buffer = term.buffer?.active;
  if (!buffer) return true;
  return buffer.viewportY >= buffer.baseY - 1;
}

function scrollTerminalToBottom(term: Terminal) {
  if (typeof term.scrollToBottom !== "function") return;

  try {
    term.scrollToBottom();
  } catch (err) {
    console.warn("[InteractiveTerminal] scrollToBottom() failed", err);
  }
}

function quietRecoveryMessage(
  connectionState: ConnectionState,
  recoveryState?: TerminalRecoveryState,
): string | null {
  if (connectionState === "workspace-offline") return null;
  if (recoveryState?.phase === "final-failure") return null;

  if (recoveryState?.phase === "recovering" || connectionState === "reconnecting") {
    const retryLabel = recoveryState?.retryCount ? ` Retry ${recoveryState.retryCount}.` : "";
    return `Reconnecting terminal…${retryLabel}`;
  }

  if (recoveryState?.phase === "connecting" || connectionState === "connecting") {
    return "Connecting terminal…";
  }

  if (
    connectionState === "disconnected" &&
    recoveryState?.isRecoverable !== false &&
    recoveryState?.lastRecoveryAction === "schedule-reconnect"
  ) {
    const retryLabel = recoveryState.retryCount ? ` Retry ${recoveryState.retryCount}.` : "";
    return `Reconnecting terminal…${retryLabel}`;
  }

  return null;
}

function finalFailureMessage(recoveryState?: TerminalRecoveryState): string {
  switch (recoveryState?.failureCategory) {
    case "auth-expired":
      return "Terminal connection ended because authentication expired.";
    case "permission-denied":
      return "Terminal connection ended because access was denied.";
    case "clone-proof-invalid":
      return "Terminal connection ended because clone authorization could not be verified.";
    case "terminal-closed":
      return "Terminal connection ended because the terminal session closed.";
    default:
      return "Terminal connection ended and automatic recovery stopped.";
  }
}

export function connectionBadgeProps(state: ConnectionState) {
  switch (state) {
    case "connected":
      return {
        variant: "default" as const,
        label: "Connected",
        className: "bg-green-600 text-white",
      };
    case "connecting":
      return {
        variant: "secondary" as const,
        label: "Connecting…",
        className: "bg-yellow-600 text-white",
      };
    case "reconnecting":
      return {
        variant: "secondary" as const,
        label: "Reconnecting…",
        className: "bg-yellow-600 text-white",
      };
    case "disconnected":
      return { variant: "secondary" as const, label: "Disconnected", className: "" };
    case "failed":
      return { variant: "destructive" as const, label: "Connection failed", className: "" };
    case "workspace-offline":
      return { variant: "destructive" as const, label: "Workspace offline", className: "" };
  }
}

export function InteractiveTerminal({
  agentId,
  workspaceId,
  sessionName,
  clonePath,
  cloneProof,
  refreshCloneTerminalIdentity,
  className,
  onConnectionStateChange,
  onRecoveryStateChange,
  onTerminalReady,
  onTerminalDestroy,
  onUserFocusRequest,
  onComposeRequest,
  onClipboardStatus,
  targetLabel,
  layoutSignal,
  mobileInputMode = false,
  suppressAutoFocus = false,
  pinToBottomOnResize = false,
  selectionModeEnabled = false,
}: InteractiveTerminalProps) {
  const { terminalWsUrl } = useRuntimeConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pinnedToBottomRef = useRef(true);
  const pinToBottomOnResizeRef = useRef(pinToBottomOnResize);
  pinToBottomOnResizeRef.current = pinToBottomOnResize;
  const mobileInputModeRef = useRef(mobileInputMode);
  mobileInputModeRef.current = mobileInputMode;
  const suppressAutoFocusRef = useRef(suppressAutoFocus);
  suppressAutoFocusRef.current = suppressAutoFocus;
  const selectionModeEnabledRef = useRef(selectionModeEnabled);
  selectionModeEnabledRef.current = selectionModeEnabled;
  const mobileTouchIntentRef = useRef<MobileTouchIntent | null>(null);
  const suppressNextClickFocusRef = useRef(false);
  const suppressNextNativePasteRef = useRef(false);
  const suppressNextNativePasteTimerRef = useRef<number | null>(null);
  const suppressedClipboardPasteStateRef = useRef<
    "pending" | "clipboard-handled-file" | "prefer-native-file" | null
  >(null);
  const pendingNativeFilePasteRef = useRef<TerminalPasteOutcome | null>(null);
  const mobileInputCleanupRef = useRef<MobileInputAdapterCleanup | null>(null);
  const { handleKeyEvent } = useKeybindings();
  const handleKeyEventRef = useRef(handleKeyEvent);
  handleKeyEventRef.current = handleKeyEvent;
  const onTerminalReadyRef = useRef(onTerminalReady);
  onTerminalReadyRef.current = onTerminalReady;
  const onTerminalDestroyRef = useRef(onTerminalDestroy);
  onTerminalDestroyRef.current = onTerminalDestroy;
  const onComposeRequestRef = useRef(onComposeRequest);
  onComposeRequestRef.current = onComposeRequest;
  const onClipboardStatusRef = useRef(onClipboardStatus);
  onClipboardStatusRef.current = onClipboardStatus;
  const targetLabelRef = useRef(targetLabel);
  targetLabelRef.current = targetLabel;
  const [reconnectId] = useState(() => {
    const RECONNECT_TTL_MS = 24 * 60 * 60 * 1000;
    const storageKey = `terminal:reconnect:${agentId}:${sessionName}`;
    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        try {
          const { id, ts } = JSON.parse(raw);
          if (typeof id === "string" && Date.now() - ts < RECONNECT_TTL_MS) {
            return id as string;
          }
        } catch {
          /* corrupted entry — regenerate */
        }
        window.localStorage.removeItem(storageKey);
      }
    }
    const id = crypto.randomUUID();
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify({ id, ts: Date.now() }));
    }
    return id;
  });
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const canRefreshCloneTerminalIdentity =
    Boolean(refreshCloneTerminalIdentity) &&
    isCloneTerminalSessionName(sessionName) &&
    isNonEmptyString(clonePath) &&
    isNonEmptyString(cloneProof);

  const refreshCloneTerminalWebSocketUrl = useCallback<TerminalRefreshUrlBeforeReconnect>(
    async (context) => {
      if (!refreshCloneTerminalIdentity || !isNonEmptyString(clonePath)) {
        return { failureCategory: "malformed-identity" };
      }

      const refreshedIdentity = await refreshCloneTerminalIdentity({
        sessionName,
        clonePath,
        reason: context.reason,
        retryCount: context.retryCount,
        closeCode: context.closeCode,
        closeCategory: context.closeCategory,
        reasonCategory: context.reasonCategory,
      });
      const validatedIdentity = validateRefreshedCloneTerminalIdentity(
        refreshedIdentity,
        sessionName,
      );
      if (validatedIdentity === "malformed-identity") {
        return { failureCategory: "malformed-identity" };
      }
      if (validatedIdentity === "session-name-mismatch") {
        return { failureCategory: "session-name-mismatch" };
      }

      const proxyUrl = terminalWsUrl;
      if (!proxyUrl) {
        return { failureCategory: "malformed-identity" };
      }

      const term = termRef.current;
      const fallbackCols = readDimensionFromUrl(
        context.currentUrl,
        "width",
        FALLBACK_TERMINAL_COLS,
      );
      const fallbackRows = readDimensionFromUrl(
        context.currentUrl,
        "height",
        FALLBACK_TERMINAL_ROWS,
      );
      const cols = normalizeTerminalDimension(term?.cols, fallbackCols);
      const rows = normalizeTerminalDimension(term?.rows, fallbackRows);

      return buildTerminalWebSocketUrl({
        proxyUrl,
        agentId,
        workspaceId,
        reconnectId,
        sessionName,
        rows,
        cols,
        clonePath: validatedIdentity.clonePath,
        cloneProof: validatedIdentity.cloneProof,
      });
    },
    [
      agentId,
      clonePath,
      reconnectId,
      refreshCloneTerminalIdentity,
      sessionName,
      terminalWsUrl,
      workspaceId,
    ],
  );

  const handleData = useCallback((data: Uint8Array | string) => {
    const term = termRef.current;
    if (!term) return;

    const shouldStayPinned = pinnedToBottomRef.current;
    term.write(data, () => {
      if (shouldStayPinned) {
        scrollTerminalToBottom(term);
      }
      pinnedToBottomRef.current = isTerminalScrolledToBottom(term);
    });
  }, []);

  const { send, resize, connectionState, recoveryState, manualReconnect } = useTerminalWebSocket({
    url: wsUrl,
    onData: handleData,
    onResizeSent: ({ rows, cols, source, sentAt }) => {
      recordMobileTerminalResizeSent(rows, cols, source, () => sentAt);
    },
    onRecoveryStateChange,
    refreshUrlBeforeReconnect: canRefreshCloneTerminalIdentity
      ? refreshCloneTerminalWebSocketUrl
      : undefined,
  });
  const recoveryMessage = quietRecoveryMessage(connectionState, recoveryState);
  const showFinalFailure =
    recoveryState?.phase === "final-failure" ||
    (connectionState === "failed" && recoveryState?.isRecoverable === false);
  const bindPinchZoom = useTerminalPinchZoom();
  const terminalInteractionProps = selectionModeEnabled ? {} : bindPinchZoom();

  useEffect(() => {
    onConnectionStateChange?.(connectionState);
  }, [connectionState, onConnectionStateChange]);

  const sendRef = useRef(send);
  const resizeRef = useRef(resize);
  sendRef.current = send;
  resizeRef.current = resize;

  const applyMobileInputAdapter = useCallback(() => {
    mobileInputCleanupRef.current?.dispose();
    mobileInputCleanupRef.current = null;

    const container = containerRef.current;
    if (!mobileInputModeRef.current || !container) return;

    if (selectionModeEnabledRef.current) {
      blurXtermMobileInput(container);
      return;
    }

    const cleanup = configureXtermMobileInput(container);
    if (cleanup.applied) {
      mobileInputCleanupRef.current = cleanup;
    }
  }, []);

  const focusInteractiveTerminal = useCallback(() => {
    const term = termRef.current;
    if (!term || selectionModeEnabledRef.current) return;

    onUserFocusRequest?.();

    if (mobileInputModeRef.current) {
      applyMobileInputAdapter();
      focusTerminalForMobileInput(term);
      return;
    }

    term.focus();
  }, [applyMobileInputAdapter, onUserFocusRequest]);

  const stopTerminalEventForSelection = useCallback(
    (
      event:
        | ReactMouseEvent<HTMLDivElement>
        | ReactPointerEvent<HTMLDivElement>
        | ReactTouchEvent<HTMLDivElement>,
    ) => {
      if (!mobileInputModeRef.current || !selectionModeEnabledRef.current) return;

      event.stopPropagation();
    },
    [],
  );

  const handleTerminalPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mobileInputModeRef.current && event.pointerType === "touch") {
        return;
      }

      focusInteractiveTerminal();
    },
    [focusInteractiveTerminal],
  );

  const beginMobileTouchScroll = useCallback((touch: Touch) => {
    mobileTouchIntentRef.current = {
      didScroll: false,
      touchIdentifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      multiTouch: false,
    };
  }, []);

  const continueMobileTouchScroll = useCallback((event: TouchEvent | ReactTouchEvent) => {
    const intent = mobileTouchIntentRef.current;
    if (!mobileInputModeRef.current || selectionModeEnabledRef.current || !intent) return;

    if (event.touches.length > 1) {
      intent.multiTouch = true;
      return;
    }

    const touch = Array.from(event.touches).find(
      (candidate) => candidate.identifier === intent.touchIdentifier,
    );
    if (!touch) return;

    const deltaX = touch.clientX - intent.startX;
    const deltaYFromStart = touch.clientY - intent.startY;
    const movedPx = Math.hypot(deltaX, deltaYFromStart);
    if (!intent.didScroll && movedPx < MOBILE_TERMINAL_SCROLL_THRESHOLD_PX) return;

    intent.didScroll = true;
    suppressNextClickFocusRef.current = true;
    preventDefaultIfCancelable(event);
    event.stopPropagation();

    const deltaY = touch.clientY - intent.lastY;
    intent.lastY = touch.clientY;
    const term = termRef.current;
    dispatchTmuxTouchWheel(term, containerRef.current, touch, deltaY);
    if (term) {
      pinnedToBottomRef.current = isTerminalScrolledToBottom(term);
    }
  }, []);

  const endMobileTouchScroll = useCallback(
    (event: TouchEvent | ReactTouchEvent) => {
      const intent = mobileTouchIntentRef.current;
      if (!intent) return;

      const ended = Array.from(event.changedTouches).some(
        (touch) => touch.identifier === intent.touchIdentifier,
      );
      if (!ended) return;

      mobileTouchIntentRef.current = null;
      suppressNextClickFocusRef.current = intent.didScroll || intent.multiTouch;
      if (!intent.didScroll && !intent.multiTouch && !selectionModeEnabledRef.current) {
        suppressNextClickFocusRef.current = true;
        focusInteractiveTerminal();
      }
    },
    [focusInteractiveTerminal],
  );

  const handleTerminalClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (mobileInputModeRef.current) {
        if (selectionModeEnabledRef.current) {
          event.stopPropagation();
          return;
        }

        if (suppressNextClickFocusRef.current) {
          suppressNextClickFocusRef.current = false;
          event.preventDefault();
          return;
        }

        focusInteractiveTerminal();
        event.preventDefault();
        return;
      }

      focusInteractiveTerminal();
    },
    [focusInteractiveTerminal],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const preventXtermTouchFocus = (event: TouchEvent | PointerEvent) => {
      if (!mobileInputModeRef.current || selectionModeEnabledRef.current) return;
      if (event.cancelable) event.preventDefault();
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (!mobileInputModeRef.current || event.touches.length !== 1) return;
      preventXtermTouchFocus(event);
      beginMobileTouchScroll(event.touches[0]);
    };
    const handleTouchMove = (event: TouchEvent) => continueMobileTouchScroll(event);
    const handleTouchEnd = (event: TouchEvent) => endMobileTouchScroll(event);
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") preventXtermTouchFocus(event);
    };

    container.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: false });
    container.addEventListener("touchstart", handleTouchStart, { capture: true, passive: false });
    container.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    container.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
    container.addEventListener("touchcancel", handleTouchEnd, { capture: true, passive: true });

    return () => {
      container.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      container.removeEventListener("touchstart", handleTouchStart, { capture: true });
      container.removeEventListener("touchmove", handleTouchMove, { capture: true });
      container.removeEventListener("touchend", handleTouchEnd, { capture: true });
      container.removeEventListener("touchcancel", handleTouchEnd, { capture: true });
    };
  }, [beginMobileTouchScroll, continueMobileTouchScroll, endMobileTouchScroll]);

  useEffect(() => {
    void layoutSignal;
    void mobileInputMode;
    void selectionModeEnabled;
    applyMobileInputAdapter();
    return () => {
      mobileInputCleanupRef.current?.dispose();
      mobileInputCleanupRef.current = null;
    };
  }, [applyMobileInputAdapter, layoutSignal, mobileInputMode, selectionModeEnabled]);

  const fitResizeAndPreserveBottom = useCallback(
    (forceScrollToBottom = false, source = "layout-refit") => {
      const fit = fitRef.current;
      const term = termRef.current;
      if (!fit || !term) return;

      const shouldPinToBottom =
        forceScrollToBottom || (pinToBottomOnResizeRef.current && pinnedToBottomRef.current);

      if (safeFit(fit)) {
        recordFitDiagnostics(term, source);
        recordResizeRequestDiagnostics(term, source);
        resizeRef.current(term.rows, term.cols, source);
        if (shouldPinToBottom) {
          scrollTerminalToBottom(term);
        }
        pinnedToBottomRef.current = isTerminalScrolledToBottom(term);
      }
    },
    [],
  );

  // When the WebSocket connects (or reconnects), re-fit the terminal and
  // send a resize message. This forces tmux to redraw with the correct
  // dimensions — critical when reattaching to an existing session where
  // the initial URL dimensions may not match the actual terminal size.
  useEffect(() => {
    if (connectionState !== "connected") return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;

    // Allow one frame for layout to settle after connection state update
    const frame = requestAnimationFrame(() => {
      fitResizeAndPreserveBottom(true, "connection-refit");
    });
    return () => cancelAnimationFrame(frame);
  }, [connectionState, fitResizeAndPreserveBottom]);

  useEffect(() => {
    const handler = (e: Event) => {
      const size = (e as CustomEvent<number>).detail;
      const term = termRef.current;
      const fit = fitRef.current;
      if (term && fit) {
        const previousFontSize = term.options.fontSize;
        term.options.fontSize = size;
        const shouldStayPinned = pinnedToBottomRef.current;
        if (safeFit(fit)) {
          recordFitDiagnostics(term, "font-size-refit");
          if (shouldStayPinned) {
            scrollTerminalToBottom(term);
          }
          pinnedToBottomRef.current = isTerminalScrolledToBottom(term);
        } else {
          term.options.fontSize = previousFontSize;
        }
      }
    };
    window.addEventListener(FONT_SIZE_EVENT, handler);
    return () => window.removeEventListener(FONT_SIZE_EVENT, handler);
  }, []);

  useEffect(() => {
    void layoutSignal;

    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;

    const frame = requestAnimationFrame(() => {
      fitResizeAndPreserveBottom(false, "layout-signal-refit");
    });
    return () => cancelAnimationFrame(frame);
  }, [layoutSignal, fitResizeAndPreserveBottom]);

  useXtermSurface({
    containerRef,
    termRef,
    fitRef,
    terminalOptions: {
      fontSize: getTerminalFontSize(),
      lineHeight: 1.4,
      cursorBlink: true,
      convertEol: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      scrollback: 0,
    },
    recreateKey: [
      agentId,
      workspaceId,
      sessionName,
      clonePath ?? "",
      cloneProof ?? "",
      reconnectId,
      terminalWsUrl,
    ].join(":"),
    onReady: async (term, fit) => {
      applyMobileInputAdapter();
      if (!mobileInputModeRef.current && !suppressAutoFocusRef.current) {
        term.focus();
      }
      if (safeFit(fit)) {
        recordFitDiagnostics(term, "initial-open-fit");
      }

      const sendRaw = (text: string) => sendRef.current(encodeInput(text));
      onTerminalReadyRef.current?.(term, sendRaw);
      const handleCapturedNativeFilePaste = (outcome: TerminalPasteOutcome) => {
        if (outcome.kind !== "asset-files" || !onComposeRequestRef.current) return;
        void handleTerminalPasteOutcome(outcome, {
          term,
          send: sendRaw,
          openCompose: onComposeRequestRef.current,
          workspaceId,
          targetLabel: targetLabelRef.current,
          onStatus: onClipboardStatusRef.current,
        });
      };
      const preferCapturedNativeFilePaste = () => {
        const pendingOutcome = pendingNativeFilePasteRef.current;
        pendingNativeFilePasteRef.current = null;
        if (pendingOutcome?.kind === "asset-files") {
          suppressedClipboardPasteStateRef.current = null;
          handleCapturedNativeFilePaste(pendingOutcome);
          return;
        }
        suppressedClipboardPasteStateRef.current = "prefer-native-file";
      };
      const pasteFromBrowserClipboard = () => {
        if (!onComposeRequestRef.current) return true;
        const shouldContinue = pasteClipboardApiToTerminal(term, sendRaw, {
          onCompose: onComposeRequestRef.current,
          workspaceId,
          targetLabel: targetLabelRef.current,
          onPasteFailure: preferCapturedNativeFilePaste,
          onPasteOutcome: (outcome) => {
            if (outcome.kind === "asset-files") {
              pendingNativeFilePasteRef.current = null;
              suppressedClipboardPasteStateRef.current = "clipboard-handled-file";
              return;
            }
            preferCapturedNativeFilePaste();
          },
          onStatus: (status) => {
            if (isTerminalPasteStatus(status)) onClipboardStatusRef.current?.(status);
          },
        });
        suppressNextNativePasteRef.current = !shouldContinue;
        suppressedClipboardPasteStateRef.current = shouldContinue ? null : "pending";
        pendingNativeFilePasteRef.current = null;
        if (suppressNextNativePasteTimerRef.current !== null) {
          window.clearTimeout(suppressNextNativePasteTimerRef.current);
          suppressNextNativePasteTimerRef.current = null;
        }
        if (suppressNextNativePasteRef.current) {
          suppressNextNativePasteTimerRef.current = window.setTimeout(() => {
            suppressNextNativePasteRef.current = false;
            suppressedClipboardPasteStateRef.current = null;
            pendingNativeFilePasteRef.current = null;
            suppressNextNativePasteTimerRef.current = null;
          }, 750);
        }
        return shouldContinue;
      };

      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
          return pasteFromBrowserClipboard();
        }
        return handleKeyEventRef.current(e);
      });

      const container = containerRef.current;
      const handlePaste = (event: ClipboardEvent) => {
        if (suppressNextNativePasteRef.current) {
          suppressNextNativePasteRef.current = false;
          if (suppressNextNativePasteTimerRef.current !== null) {
            window.clearTimeout(suppressNextNativePasteTimerRef.current);
            suppressNextNativePasteTimerRef.current = null;
          }
          if (nativePasteHasFiles(event)) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            const nativeOutcome = readNativePasteOutcome(event);
            if (nativeOutcome.kind === "asset-files") {
              if (suppressedClipboardPasteStateRef.current === "prefer-native-file") {
                suppressedClipboardPasteStateRef.current = null;
                pendingNativeFilePasteRef.current = null;
                handleCapturedNativeFilePaste(nativeOutcome);
                return;
              }
              if (suppressedClipboardPasteStateRef.current === "pending") {
                pendingNativeFilePasteRef.current = nativeOutcome;
              }
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          suppressedClipboardPasteStateRef.current = null;
          pendingNativeFilePasteRef.current = null;
          return;
        }
        if (!onComposeRequestRef.current) return;
        void pasteNativeClipboardEventToTerminal(event, {
          term,
          send: sendRaw,
          onCompose: onComposeRequestRef.current,
          workspaceId,
          targetLabel: targetLabelRef.current,
          onStatus: onClipboardStatusRef.current,
        });
      };
      const handleDragOver = (event: DragEvent) => {
        if (!onComposeRequestRef.current || !event.dataTransfer?.items.length) return;
        event.preventDefault();
      };
      const handleDrop = (event: DragEvent) => {
        if (!onComposeRequestRef.current) return;
        void dropDataTransferToTerminal(event, {
          term,
          send: sendRaw,
          onCompose: onComposeRequestRef.current,
          workspaceId,
          targetLabel: targetLabelRef.current,
          onStatus: onClipboardStatusRef.current,
        });
      };
      container?.addEventListener("paste", handlePaste, { capture: true });
      container?.addEventListener("dragover", handleDragOver, { capture: true });
      container?.addEventListener("drop", handleDrop, { capture: true });

      term.onData((data) => {
        const filteredData = stripXtermDeviceAnswerbacks(data);
        if (filteredData.length === 0) return;
        sendRef.current(encodeInput(filteredData));
      });

      term.onResize(({ rows, cols }) => {
        recordMobileTerminalXtermDimensions(rows, cols, "xterm-on-resize");
        recordMobileTerminalResizeRequest(rows, cols, "xterm-on-resize");
        resizeRef.current(rows, cols, "xterm-on-resize");
      });

      if (typeof term.onScroll === "function") {
        term.onScroll(() => {
          pinnedToBottomRef.current = isTerminalScrolledToBottom(term);
        });
      }

      if (pinToBottomOnResizeRef.current) {
        scrollTerminalToBottom(term);
      }

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (termRef.current !== term) return;
      fitResizeAndPreserveBottom(Boolean(pinToBottomOnResizeRef.current), "initial-layout-refit");

      const proxyUrl = terminalWsUrl;
      if (!proxyUrl) {
        console.error(
          "runtime config terminalWsUrl is not set (check NEXT_PUBLIC_TERMINAL_WS_URL on the server)",
        );
        return;
      }
      setWsUrl(
        buildTerminalWebSocketUrl({
          proxyUrl,
          agentId,
          workspaceId,
          reconnectId,
          rows: term.rows,
          cols: term.cols,
          sessionName,
          clonePath,
          cloneProof,
        }),
      );

      return () => {
        container?.removeEventListener("paste", handlePaste, { capture: true });
        container?.removeEventListener("dragover", handleDragOver, { capture: true });
        container?.removeEventListener("drop", handleDrop, { capture: true });
        suppressedClipboardPasteStateRef.current = null;
        pendingNativeFilePasteRef.current = null;
      };
    },
    onResize: () => {
      fitResizeAndPreserveBottom(false, "resize-observer-refit");
    },
    onDispose: () => {
      mobileTouchIntentRef.current = null;
      suppressNextClickFocusRef.current = false;
      suppressNextNativePasteRef.current = false;
      if (suppressNextNativePasteTimerRef.current !== null) {
        window.clearTimeout(suppressNextNativePasteTimerRef.current);
        suppressNextNativePasteTimerRef.current = null;
      }
      mobileInputCleanupRef.current?.dispose();
      mobileInputCleanupRef.current = null;
      onTerminalDestroyRef.current?.();
    },
  });

  return (
    <div
      className={cn("relative flex flex-col bg-[#0a0a0a] overflow-hidden", className)}
      data-connection-state={connectionState}
      data-terminal-surface="true"
    >
      {connectionState === "workspace-offline" && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle />
          <AlertDescription>
            Workspace is offline. The terminal will reconnect when the workspace comes back online.
          </AlertDescription>
        </Alert>
      )}
      {recoveryMessage && (
        <Alert
          className="rounded-none border-x-0 border-t-0"
          data-testid="terminal-recovery-status"
        >
          <AlertDescription>{recoveryMessage}</AlertDescription>
        </Alert>
      )}
      {showFinalFailure && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle />
          <AlertDescription>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{finalFailureMessage(recoveryState)}</span>
              {recoveryState?.canRetry && (
                <button
                  type="button"
                  className="rounded border border-destructive/30 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  onClick={manualReconnect}
                >
                  Retry terminal connection
                </button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: focus delegation to xterm which handles its own keyboard */}
      <div
        className="min-h-0 flex-1 p-1"
        data-testid="terminal-fit-padding"
        onClick={handleTerminalClick}
        onPointerDown={handleTerminalPointerDown}
      >
        <div
          ref={containerRef}
          className="h-full min-h-0 w-full"
          data-testid="terminal-fit-host"
          data-sidebar-gesture-ignore={selectionModeEnabled ? "true" : undefined}
          data-terminal-selection-mode={selectionModeEnabled ? "true" : undefined}
          {...terminalInteractionProps}
          onClickCapture={stopTerminalEventForSelection}
          onMouseDownCapture={stopTerminalEventForSelection}
          onPointerDownCapture={stopTerminalEventForSelection}
          onTouchStartCapture={stopTerminalEventForSelection}
        />
      </div>
    </div>
  );
}
