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
import { useScrollbackHydration } from "@/hooks/useScrollbackHydration";
import { TerminalHistoryPanel } from "@/components/workspaces/TerminalHistoryPanel";
import { JumpToBottom } from "@/components/workspaces/JumpToBottom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import "@/styles/xterm.css";

const RECONNECT_TTL_MS = 24 * 60 * 60 * 1000;

export function getOrCreateReconnectId(agentId: string, sessionName: string): string {
  const storageKey = `terminal:reconnect:${agentId}:${sessionName}`;
  if (typeof window !== "undefined") {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      try {
        const { id, ts } = JSON.parse(raw);
        if (typeof id === "string" && Date.now() - ts < RECONNECT_TTL_MS) {
          return id;
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
}

interface InteractiveTerminalProps {
  agentId: string;
  workspaceId: string;
  sessionName: string;
  className?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
}

const TERMINAL_THEME = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  black: "#1a1a1a",
  brightBlack: "#444444",
  red: "#ff5555",
  brightRed: "#ff6e6e",
  green: "#50fa7b",
  brightGreen: "#69ff94",
  yellow: "#f1fa8c",
  brightYellow: "#ffffa5",
  blue: "#6272a4",
  brightBlue: "#8be9fd",
  magenta: "#ff79c6",
  brightMagenta: "#ff92d0",
  cyan: "#8be9fd",
  brightCyan: "#a4ffff",
  white: "#f8f8f2",
  brightWhite: "#ffffff",
};

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
}: InteractiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [reconnectId, setReconnectId] = useState(() => getOrCreateReconnectId(agentId, sessionName));
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleJumpToBottom = useCallback(() => {
    setShowHistoryPanel(false);
    setIsAtBottom(true);
    termRef.current?.scrollToBottom();
  }, []);

  const handleReconnectIdExpired = useCallback(() => {
    const storageKey = `terminal:reconnect:${agentId}:${sessionName}`;
    const newId = crypto.randomUUID();
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify({ id: newId, ts: Date.now() }));
    }
    console.log(`[terminal] Regenerating reconnectId after consecutive failures`);
    setReconnectId(newId);
  }, [agentId, sessionName]);

  const handleData = useCallback((data: Uint8Array | string) => {
    if (termRef.current) {
      termRef.current.write(data);
    }
  }, []);

  const { hydrationState, isGatingLiveData } = useScrollbackHydration({
    reconnectId,
    terminalRef: termRef,
    isConnected: wsUrl !== null,
  });

  const { send, resize, connectionState, reconnectAttempt, reconnect } = useTerminalWebSocket({
    url: wsUrl,
    onData: handleData,
    onReconnectIdExpired: handleReconnectIdExpired,
    isGatingLiveData,
  });

  useEffect(() => {
    onConnectionStateChange?.(connectionState);
  }, [connectionState, onConnectionStateChange]);

  const sendRef = useRef(send);
  const resizeRef = useRef(resize);
  sendRef.current = send;
  resizeRef.current = resize;

  useEffect(() => {
    if (!containerRef.current) return;

    let mounted = true;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      if (!mounted || !containerRef.current) return;

      term = new Terminal({
        theme: TERMINAL_THEME,
        fontFamily:
          "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 13,
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

      await document.fonts.ready;
      if (!mounted) return;
      fit.fit();

      term.onData((data) => {
        sendRef.current(encodeInput(data));
      });

      term.onResize(({ rows, cols }) => {
        resizeRef.current(rows, cols);
      });

      const localTerm = term;
      localTerm.onScroll(() => {
        if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
        scrollDebounceRef.current = setTimeout(() => {
          const buf = localTerm.buffer.active;
          const atBottom = buf.viewportY >= buf.baseY;
          setIsAtBottom(atBottom);
          if (buf.viewportY === 0) {
            setShowHistoryPanel(true);
          }
        }, 100);
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

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && fitRef.current) {
          fitRef.current.fit();
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      mounted = false;
      resizeObserver.disconnect();
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
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
      {hydrationState === "loading" && (
        <Alert variant="default" className="rounded-none border-x-0 border-t-0 bg-blue-900/50 border-blue-700">
          <Loader2 className="animate-spin" />
          <AlertDescription>Restoring history…</AlertDescription>
        </Alert>
      )}
      {hydrationState === "error" && (
        <Alert variant="default" className="rounded-none border-x-0 border-t-0 bg-yellow-900/50 border-yellow-700">
          <AlertCircle />
          <AlertDescription>History unavailable</AlertDescription>
        </Alert>
      )}
      {connectionState === "workspace-offline" && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle />
          <AlertDescription>
            Workspace is offline. The terminal will reconnect when the workspace comes back online.
          </AlertDescription>
        </Alert>
      )}
      {connectionState === "reconnecting" && (
        <Alert variant="default" className="rounded-none border-x-0 border-t-0 bg-yellow-900/50 border-yellow-700">
          <RefreshCw className="animate-spin" />
          <AlertDescription className="flex items-center justify-between w-full">
            <span>Reconnecting… attempt {reconnectAttempt}</span>
            <Button variant="outline" size="sm" onClick={reconnect}>
              Reconnect Now
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {connectionState === "failed" && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle />
          <AlertDescription className="flex items-center justify-between w-full">
            <span>Connection failed. Retries will continue automatically.</span>
            <Button variant="outline" size="sm" onClick={reconnect}>
              Reconnect Now
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <TerminalHistoryPanel
        reconnectId={reconnectId}
        visible={showHistoryPanel}
        onScrollToBottom={() => setShowHistoryPanel(false)}
      />
      <div ref={containerRef} className="flex-1 p-1" />
      <JumpToBottom
        visible={showHistoryPanel || !isAtBottom}
        onClick={handleJumpToBottom}
      />
    </div>
  );
}
