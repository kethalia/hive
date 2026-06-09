"use client";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { X } from "lucide-react";
import { useRef } from "react";
import { useXtermSurface } from "@/hooks/useXtermSurface";
import { cn } from "@/lib/utils";

interface TerminalPanelProps {
  onClose: () => void;
  /** Ref that callers use to write lines into the terminal. */
  writeRef: React.MutableRefObject<((line: string) => void) | null>;
  /** Called once xterm is mounted and ready to receive output. */
  onReady?: () => void;
  className?: string;
}

/**
 * xterm.js terminal panel.
 *
 * Uses dynamic-import inside useEffect to ensure xterm never runs on the
 * server. The parent must import this component with `dynamic(..., { ssr: false })`.
 *
 * `writeRef` is populated once the terminal is ready — callers write lines
 * by calling `writeRef.current?.(line)`.
 */
export function TerminalPanel({ onClose, writeRef, onReady, className }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useXtermSurface({
    containerRef,
    termRef,
    fitRef,
    terminalOptions: {
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      convertEol: true,
      scrollback: 5000,
    },
    recreateKey: "template-terminal-panel",
    onReady: (term, fit) => {
      fit.fit();
      writeRef.current = (line: string) => {
        term.writeln(line);
      };
      onReady?.();
    },
    onResize: (_term, fit) => {
      fit.fit();
    },
    onDispose: () => {
      writeRef.current = null;
    },
  });

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border border-border bg-[#0a0a0a] overflow-hidden",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <span className="text-xs font-mono text-muted-foreground">push output</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Close terminal"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* xterm container */}
      <div ref={containerRef} className="flex-1 p-2 min-h-[200px]" />
    </div>
  );
}
