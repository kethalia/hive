"use client";

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
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

      // Explicitly load Fira Code before creating the terminal.
      // CSS @font-face fonts only load when referenced by DOM text —
      // xterm uses <canvas>, which doesn't trigger the load.
      try {
        await document.fonts.load("13px 'Fira Code'");
      } catch {
        // Font load failed — terminal will fall back to monospace
      }

      term = new Terminal({
        theme: {
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
        },
        fontFamily: "'Fira Code', monospace",
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

    const handleResize = () => fitRef.current?.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      mounted = false;
      window.removeEventListener("resize", handleResize);
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
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <span className="text-xs font-mono text-muted-foreground">push output</span>
        <button
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
