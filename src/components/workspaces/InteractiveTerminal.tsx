"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { cn } from "@/lib/utils";
import { encodeInput } from "@/lib/terminal/protocol";
import {
  useTerminalWebSocket,
  type ConnectionState,
} from "@/hooks/useTerminalWebSocket";
import { useKeybindings } from "@/hooks/useKeybindings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { TERMINAL_THEME, TERMINAL_FONT_FAMILY, loadTerminalFont } from "@/lib/terminal/config";
import { getTerminalFontSize, EVENT_NAME as FONT_SIZE_EVENT } from "@/lib/terminal/font-size";
import "@/styles/xterm.css";

interface InteractiveTerminalProps {
  agentId: string;
  workspaceId: string;
  sessionName: string;
  className?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
  onTerminalDestroy?: () => void;
}

export function connectionBadgeProps(state: ConnectionState) {
  switch (state) {
    case "connected":
      return { variant: "default" as const, label: "Connected", className: "bg-green-600 text-white" };
    case "connecting":
      return { variant: "secondary" as const, label: "Connecting…", className: "bg-yellow-600 text-white" };
    case "reconnecting":
      return { variant: "secondary" as const, label: "Reconnecting…", className: "bg-yellow-600 text-white" };
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
}: InteractiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
        } catch { /* corrupted entry — regenerate */ }
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
    if (termRef.current) {
      termRef.current.write(data);
    }
  }, []);

  const { send, resize, connectionState } = useTerminalWebSocket({
    url: wsUrl,
    onData: handleData,
  });

  useEffect(() => {
    onConnectionStateChange?.(connectionState);
  }, [connectionState, onConnectionStateChange]);

  const sendRef = useRef(send);
  const resizeRef = useRef(resize);
  sendRef.current = send;
  resizeRef.current = resize;

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
      fit.fit();
      resizeRef.current(term.rows, term.cols);
    });
    return () => cancelAnimationFrame(frame);
  }, [connectionState]);

  useEffect(() => {
    const handler = (e: Event) => {
      const size = (e as CustomEvent<number>).detail;
      const term = termRef.current;
      const fit = fitRef.current;
      if (term && fit) {
        term.options.fontSize = size;
        fit.fit();
      }
    };
    window.addEventListener(FONT_SIZE_EVENT, handler);
    return () => window.removeEventListener(FONT_SIZE_EVENT, handler);
  }, []);

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
      term.focus();

      termRef.current = term;
      fitRef.current = fit;
      fit.fit();

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

      // Wait for browser layout paint before reading dimensions
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!mounted) return;
      fit.fit();

      const dims = { rows: term.rows, cols: term.cols };
      const proxyUrl = process.env.NEXT_PUBLIC_TERMINAL_WS_URL;
      if (!proxyUrl) {
        console.error("NEXT_PUBLIC_TERMINAL_WS_URL is not set");
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
          resizeTimer = setTimeout(() => fitRef.current?.fit(), 50);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      mounted = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      onTerminalDestroyRef.current?.();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId, reconnectId, sessionName]);

  return (
    <div
      className={cn(
        "relative flex flex-col bg-[#0a0a0a] overflow-hidden",
        className,
      )}
    >
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

      <div ref={containerRef} className="flex-1 p-1" onClick={() => termRef.current?.focus()} />
    </div>
  );
}
