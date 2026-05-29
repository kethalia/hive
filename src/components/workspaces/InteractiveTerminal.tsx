"use client";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { AlertCircle } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useTerminalPinchZoom } from "@/hooks/useTerminalPinchZoom";
import { type ConnectionState, useTerminalWebSocket } from "@/hooks/useTerminalWebSocket";
import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";
import { getClientRuntimeConfig } from "@/lib/runtime-config";
import { loadTerminalFont, TERMINAL_FONT_FAMILY, TERMINAL_THEME } from "@/lib/terminal/config";
import { EVENT_NAME as FONT_SIZE_EVENT, getTerminalFontSize } from "@/lib/terminal/font-size";
import {
  configureXtermMobileInput,
  focusTerminalForMobileInput,
  type MobileInputAdapterCleanup,
} from "@/lib/terminal/mobile-input-adapter";
import { encodeInput } from "@/lib/terminal/protocol";
import { cn } from "@/lib/utils";
import "@/styles/xterm.css";

interface InteractiveTerminalProps {
  agentId: string;
  workspaceId: string;
  sessionName: string;
  className?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
  onTerminalDestroy?: () => void;
  layoutSignal?: unknown;
  mobileInputMode?: boolean;
  pinToBottomOnResize?: boolean;
}

interface MobileTouchIntent {
  didScroll: boolean;
  lineRemainder: number;
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  multiTouch: boolean;
}

const MOBILE_TERMINAL_SCROLL_THRESHOLD_PX = Math.max(TAP_THRESHOLD_PX + 3, 8);
const FALLBACK_TERMINAL_LINE_HEIGHT_PX = 20;

function terminalLineHeightPx(term: Terminal | null): number {
  const fontSize = Number(term?.options?.fontSize);
  const lineHeight = Number(term?.options?.lineHeight);
  const estimated = fontSize * (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 1.4);
  return Number.isFinite(estimated) && estimated > 0 ? estimated : FALLBACK_TERMINAL_LINE_HEIGHT_PX;
}

function preventDefaultIfCancelable(event: { cancelable?: boolean; preventDefault: () => void }) {
  if (event.cancelable) {
    event.preventDefault();
  }
}

function scrollTerminalByTouchDelta(
  term: Terminal | null,
  intent: MobileTouchIntent,
  deltaY: number,
) {
  if (!term || typeof term.scrollLines !== "function") return;

  intent.lineRemainder += -deltaY / terminalLineHeightPx(term);
  const wholeLines =
    intent.lineRemainder > 0 ? Math.floor(intent.lineRemainder) : Math.ceil(intent.lineRemainder);
  if (wholeLines === 0) return;

  term.scrollLines(wholeLines);
  intent.lineRemainder -= wholeLines;
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
  className,
  onConnectionStateChange,
  onTerminalReady,
  onTerminalDestroy,
  layoutSignal,
  mobileInputMode = false,
  pinToBottomOnResize = false,
}: InteractiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pinnedToBottomRef = useRef(true);
  const pinToBottomOnResizeRef = useRef(pinToBottomOnResize);
  pinToBottomOnResizeRef.current = pinToBottomOnResize;
  const mobileInputModeRef = useRef(mobileInputMode);
  mobileInputModeRef.current = mobileInputMode;
  const mobileTouchIntentRef = useRef<MobileTouchIntent | null>(null);
  const activeMobileTouchPointersRef = useRef(new Set<number>());
  const suppressNextClickFocusRef = useRef(false);
  const mobileInputCleanupRef = useRef<MobileInputAdapterCleanup | null>(null);
  const { handleKeyEvent } = useKeybindings();
  const handleKeyEventRef = useRef(handleKeyEvent);
  handleKeyEventRef.current = handleKeyEvent;
  const onTerminalReadyRef = useRef(onTerminalReady);
  onTerminalReadyRef.current = onTerminalReady;
  const onTerminalDestroyRef = useRef(onTerminalDestroy);
  onTerminalDestroyRef.current = onTerminalDestroy;
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

  const { send, resize, connectionState } = useTerminalWebSocket({
    url: wsUrl,
    onData: handleData,
  });
  const bindPinchZoom = useTerminalPinchZoom();

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

    if (!mobileInputModeRef.current || !containerRef.current) return;

    const cleanup = configureXtermMobileInput(containerRef.current);
    if (cleanup.applied) {
      mobileInputCleanupRef.current = cleanup;
    }
  }, []);

  const focusInteractiveTerminal = useCallback(() => {
    const term = termRef.current;
    if (!term) return;

    if (mobileInputModeRef.current) {
      applyMobileInputAdapter();
      focusTerminalForMobileInput(term);
      return;
    }

    term.focus();
  }, [applyMobileInputAdapter]);

  const handleTerminalPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!mobileInputModeRef.current || event.pointerType !== "touch") {
        focusInteractiveTerminal();
        return;
      }

      activeMobileTouchPointersRef.current.add(event.pointerId);
      mobileTouchIntentRef.current = {
        didScroll: false,
        lineRemainder: 0,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        multiTouch: activeMobileTouchPointersRef.current.size > 1,
      };
    },
    [focusInteractiveTerminal],
  );

  const handleTerminalPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!mobileInputModeRef.current || event.pointerType !== "touch") return;

    const intent = mobileTouchIntentRef.current;
    if (!intent || intent.pointerId !== event.pointerId) return;

    if (activeMobileTouchPointersRef.current.size > 1) {
      intent.multiTouch = true;
      return;
    }

    const deltaX = event.clientX - intent.startX;
    const deltaYFromStart = event.clientY - intent.startY;
    const movedPx = Math.hypot(deltaX, deltaYFromStart);
    if (!intent.didScroll && movedPx < MOBILE_TERMINAL_SCROLL_THRESHOLD_PX) return;

    intent.didScroll = true;
    suppressNextClickFocusRef.current = true;
    preventDefaultIfCancelable(event);

    const deltaY = event.clientY - intent.lastY;
    intent.lastY = event.clientY;
    const term = termRef.current;
    scrollTerminalByTouchDelta(term, intent, deltaY);
    if (term) {
      pinnedToBottomRef.current = isTerminalScrolledToBottom(term);
    }
  }, []);

  const handleTerminalPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!mobileInputModeRef.current || event.pointerType !== "touch") return;

      activeMobileTouchPointersRef.current.delete(event.pointerId);
      const intent = mobileTouchIntentRef.current;
      if (!intent || intent.pointerId !== event.pointerId) return;

      const movedPx = Math.hypot(event.clientX - intent.startX, event.clientY - intent.startY);
      const shouldFocus =
        !intent.didScroll && !intent.multiTouch && movedPx <= MOBILE_TERMINAL_SCROLL_THRESHOLD_PX;
      mobileTouchIntentRef.current = null;

      if (shouldFocus) {
        suppressNextClickFocusRef.current = true;
        focusInteractiveTerminal();
      } else {
        suppressNextClickFocusRef.current = true;
      }
    },
    [focusInteractiveTerminal],
  );

  const handleTerminalPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      activeMobileTouchPointersRef.current.delete(event.pointerId);
      mobileTouchIntentRef.current = null;
      suppressNextClickFocusRef.current = true;
    }
  }, []);

  const handleTerminalClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (mobileInputModeRef.current && suppressNextClickFocusRef.current) {
        suppressNextClickFocusRef.current = false;
        event.preventDefault();
        return;
      }

      focusInteractiveTerminal();
    },
    [focusInteractiveTerminal],
  );

  useEffect(() => {
    void layoutSignal;
    void mobileInputMode;
    applyMobileInputAdapter();
    return () => {
      mobileInputCleanupRef.current?.dispose();
      mobileInputCleanupRef.current = null;
    };
  }, [applyMobileInputAdapter, layoutSignal, mobileInputMode]);

  const fitResizeAndPreserveBottom = useCallback((forceScrollToBottom = false) => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;

    const shouldPinToBottom =
      forceScrollToBottom || (pinToBottomOnResizeRef.current && pinnedToBottomRef.current);

    if (safeFit(fit)) {
      resizeRef.current(term.rows, term.cols);
      if (shouldPinToBottom) {
        scrollTerminalToBottom(term);
      }
      pinnedToBottomRef.current = isTerminalScrolledToBottom(term);
    }
  }, []);

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
      fitResizeAndPreserveBottom(true);
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
      fitResizeAndPreserveBottom();
    });
    return () => cancelAnimationFrame(frame);
  }, [layoutSignal, fitResizeAndPreserveBottom]);

  useEffect(() => {
    if (!containerRef.current) return;

    let mounted = true;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (!mounted || !containerRef.current) return;

      await loadTerminalFont();

      term = new Terminal({
        theme: TERMINAL_THEME,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: getTerminalFontSize(),
        lineHeight: 1.4,
        cursorBlink: true,
        convertEol: true,
        scrollback: 10000,
      });

      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);

      termRef.current = term;
      fitRef.current = fit;
      applyMobileInputAdapter();
      if (!mobileInputModeRef.current) {
        term.focus();
      }
      safeFit(fit);

      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        return handleKeyEventRef.current(e);
      });

      onTerminalReadyRef.current?.(term, (text) => sendRef.current(encodeInput(text)));

      term.onData((data) => {
        sendRef.current(encodeInput(data));
      });

      term.onResize(({ rows, cols }) => {
        resizeRef.current(rows, cols);
      });

      if (typeof term.onScroll === "function") {
        term.onScroll(() => {
          pinnedToBottomRef.current = isTerminalScrolledToBottom(term as Terminal);
        });
      }

      if (pinToBottomOnResizeRef.current) {
        scrollTerminalToBottom(term);
      }

      // Wait for browser layout paint before reading dimensions
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!mounted) return;
      fitResizeAndPreserveBottom(Boolean(pinToBottomOnResizeRef.current));

      const dims = { rows: term.rows, cols: term.cols };
      const proxyUrl = getClientRuntimeConfig().terminalWsUrl;
      if (!proxyUrl) {
        console.error(
          "runtime config terminalWsUrl is not set (check NEXT_PUBLIC_TERMINAL_WS_URL on the server)",
        );
        return;
      }
      const params = new URLSearchParams({
        agentId,
        workspaceId,
        reconnectId,
        width: String(dims.cols),
        height: String(dims.rows),
        sessionName,
      });
      setWsUrl(`${proxyUrl}/ws?${params.toString()}`);
    })();

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && fitRef.current) {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            fitResizeAndPreserveBottom();
          }, 50);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      mounted = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      activeMobileTouchPointersRef.current.clear();
      mobileTouchIntentRef.current = null;
      suppressNextClickFocusRef.current = false;
      mobileInputCleanupRef.current?.dispose();
      mobileInputCleanupRef.current = null;
      onTerminalDestroyRef.current?.();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [
    agentId,
    applyMobileInputAdapter,
    fitResizeAndPreserveBottom,
    reconnectId,
    sessionName,
    workspaceId,
  ]);

  return (
    <div className={cn("relative flex flex-col bg-[#0a0a0a] overflow-hidden", className)}>
      {connectionState === "workspace-offline" && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle />
          <AlertDescription>
            Workspace is offline. The terminal will reconnect when the workspace comes back online.
          </AlertDescription>
        </Alert>
      )}
      {connectionState === "failed" && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle />
          <AlertDescription>
            Connection failed after multiple attempts. Refresh the page to try again.
          </AlertDescription>
        </Alert>
      )}

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: focus delegation to xterm which handles its own keyboard */}
      <div
        ref={containerRef}
        className="flex-1 p-1"
        {...bindPinchZoom()}
        onClick={handleTerminalClick}
        onPointerCancel={handleTerminalPointerCancel}
        onPointerDown={handleTerminalPointerDown}
        onPointerMove={handleTerminalPointerMove}
        onPointerUp={handleTerminalPointerEnd}
      />
    </div>
  );
}
