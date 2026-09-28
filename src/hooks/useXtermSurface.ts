"use client";

import type { FitAddon } from "@xterm/addon-fit";
import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import type { MutableRefObject, RefObject } from "react";
import { useEffect, useRef } from "react";
import { loadTerminalFont, TERMINAL_FONT_FAMILY, TERMINAL_THEME } from "@/lib/terminal/config";

import type { TerminalFileActionHandler } from "@/lib/terminal/link-target";

interface UseXtermSurfaceOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  termRef: MutableRefObject<Terminal | null>;
  fitRef: MutableRefObject<FitAddon | null>;
  terminalOptions: ITerminalOptions;
  resizeDelayMs?: number;
  allowClipboardWrite?: boolean;
  onFileAction?: TerminalFileActionHandler;
  recreateKey: string;
  onReady?: (
    term: Terminal,
    fit: FitAddon,
  ) => Promise<(() => void) | undefined> | (() => void) | undefined | void;
  onResize?: (term: Terminal, fit: FitAddon) => void;
  onDispose?: () => void;
}

export function useXtermSurface({
  containerRef,
  termRef,
  fitRef,
  terminalOptions,
  resizeDelayMs = 50,
  allowClipboardWrite = false,
  onFileAction,
  recreateKey,
  onReady,
  onResize,
  onDispose,
}: UseXtermSurfaceOptions): void {
  const fileActionRef = useRef(onFileAction);
  fileActionRef.current = onFileAction;
  // biome-ignore lint/correctness/useExhaustiveDependencies: xterm setup is recreated only when the caller changes the explicit lifecycle key.
  useEffect(() => {
    if (!containerRef.current) return;

    let mounted = true;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let browserCleanup: (() => void) | undefined;
    let readyCleanup: (() => void) | undefined;
    const host = containerRef.current;

    (async () => {
      const [{ Terminal }, { FitAddon }, { installTerminalBrowserIntegration }] = await Promise.all(
        [
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@/lib/terminal/browser-integration"),
        ],
      );

      if (!mounted || !containerRef.current) return;

      await loadTerminalFont();
      if (!mounted || !containerRef.current) return;

      const term = new Terminal({
        theme: TERMINAL_THEME,
        fontFamily: TERMINAL_FONT_FAMILY,
        minimumContrastRatio: 4.5,
        ...terminalOptions,
      });
      const fit = new FitAddon();

      term.loadAddon(fit);
      term.open(containerRef.current);
      browserCleanup = installTerminalBrowserIntegration(term, {
        allowClipboardWrite,
        ...(onFileAction
          ? { onFileAction: (path, action) => fileActionRef.current?.(path, action) }
          : {}),
      });
      termRef.current = term;
      fitRef.current = fit;

      readyCleanup = (await onReady?.(term, fit)) ?? undefined;
    })();

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0 || !fitRef.current || !termRef.current) continue;

        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const term = termRef.current;
          const fit = fitRef.current;
          if (term && fit) onResize?.(term, fit);
        }, resizeDelayMs);
      }
    });
    resizeObserver.observe(host);

    return () => {
      mounted = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      readyCleanup?.();
      browserCleanup?.();
      onDispose?.();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [recreateKey]);
}
