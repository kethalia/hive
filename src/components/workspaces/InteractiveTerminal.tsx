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
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import "@/styles/xterm.css";

interface InteractiveTerminalProps {
  agentId: string;
  sessionName: string;
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

function connectionBadgeProps(state: ConnectionState) {
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
  sessionName,
  className,
}: InteractiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [reconnectId] = useState(() => {
    const storageKey = `terminal:reconnect:${agentId}:${sessionName}`;
    const stored = typeof window !== "undefined"
      ? window.localStorage.getItem(storageKey)
      : null;
    if (stored) return stored;
    const id = crypto.randomUUID();
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, id);
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

      // Wait for browser layout paint before reading dimensions
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!mounted) return;
      fit.fit();

      const dims = { rows: term.rows, cols: term.cols };
      const proxyUrl = process.env.NEXT_PUBLIC_TERMINAL_WS_URL;
      const params = new URLSearchParams({
        agentId,
        reconnectId,
        width: String(dims.cols),
        height: String(dims.rows),
        sessionName,
      });
      setWsUrl(`${proxyUrl}/ws?${params.toString()}`);
    })();

    const handleResize = () => {
      if (fitRef.current && termRef.current) {
        fitRef.current.fit();
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      mounted = false;
      window.removeEventListener("resize", handleResize);
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId, reconnectId, sessionName]);

  const badge = connectionBadgeProps(connectionState);

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
        <Badge variant={badge.variant} className={badge.className}>
          {badge.label}
        </Badge>
      </div>

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

      <div ref={containerRef} className="flex-1 p-2 min-h-[400px]" />
    </div>
  );
}
