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

interface InteractiveTerminalProps {
  agentId: string;
  sessionName: string;
  coderUrl: string;
  className?: string;
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

function connectionBadge(state: ConnectionState) {
  switch (state) {
    case "connected":
      return { color: "bg-green-500", label: "Connected" };
    case "connecting":
    case "reconnecting":
      return { color: "bg-yellow-500", label: state === "connecting" ? "Connecting…" : "Reconnecting…" };
    case "disconnected":
      return { color: "bg-gray-500", label: "Disconnected" };
    case "failed":
      return { color: "bg-red-500", label: "Connection failed" };
    case "workspace-offline":
      return { color: "bg-red-500", label: "Workspace offline" };
  }
}

export function InteractiveTerminal({
  agentId,
  sessionName,
  coderUrl,
  className,
}: InteractiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [reconnectId] = useState(() => crypto.randomUUID());
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const pendingResizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const termReadyRef = useRef(false);

  const handleData = useCallback((data: Uint8Array | string) => {
    if (termRef.current) {
      if (data instanceof Uint8Array) {
        termRef.current.write(data);
      } else {
        termRef.current.write(data);
      }
    }
  }, []);

  const { send, resize, connectionState } = useTerminalWebSocket({
    url: wsUrl,
    onData: handleData,
  });

  const sendRef = useRef(send);
  const resizeRef = useRef(resize);
  sendRef.current = send;
  resizeRef.current = resize;

  useEffect(() => {
    if (connectionState === "connected" && pendingResizeRef.current) {
      const { rows, cols } = pendingResizeRef.current;
      pendingResizeRef.current = null;
      resizeRef.current(rows, cols);
    }
  }, [connectionState]);

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

      termReadyRef.current = true;

      const dims = { rows: term.rows, cols: term.cols };
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const params = new URLSearchParams({
        agentId,
        reconnectId,
        width: String(dims.cols),
        height: String(dims.rows),
        sessionName,
      });
      setWsUrl(`${protocol}//${host}/api/terminal/ws?${params.toString()}`);
    })();

    const handleResize = () => {
      if (fitRef.current && termRef.current) {
        fitRef.current.fit();
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      mounted = false;
      termReadyRef.current = false;
      window.removeEventListener("resize", handleResize);
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId, reconnectId, sessionName]);

  const badge = connectionBadge(connectionState);

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border border-border bg-[#0a0a0a] overflow-hidden",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <span className="text-xs font-mono text-muted-foreground">
          {sessionName}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={cn("inline-block h-2 w-2 rounded-full", badge.color)}
            title={badge.label}
          />
          <span className="text-xs text-muted-foreground">{badge.label}</span>
        </div>
      </div>

      {connectionState === "workspace-offline" && (
        <div className="flex items-center justify-center bg-red-950/30 px-3 py-2 text-sm text-red-400">
          Workspace is offline. The terminal will reconnect when the workspace
          comes back online.
        </div>
      )}
      {connectionState === "failed" && (
        <div className="flex items-center justify-center bg-red-950/30 px-3 py-2 text-sm text-red-400">
          Connection failed after multiple attempts. Refresh the page to try
          again.
        </div>
      )}

      <div ref={containerRef} className="flex-1 p-2 min-h-[400px]" />
    </div>
  );
}
