"use client";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { loadTerminalFont, TERMINAL_FONT_FAMILY, TERMINAL_THEME } from "@/lib/terminal/config";
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
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: false,
        convertEol: true,
        scrollback: 5000,
      });

      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      // Expose write function to caller
      writeRef.current = (line: string) => {
        term?.writeln(line);
      };

      // Signal to caller that the terminal is ready to receive output
      onReady?.();
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
      writeRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [writeRef, onReady]);

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
