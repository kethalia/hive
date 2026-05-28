"use client";

import type { ReactNode } from "react";
import { useLayoutEffect } from "react";
import { MobileTerminalDiagnosticsOverlay } from "@/components/terminal/MobileTerminalDiagnosticsOverlay";
import {
  applyMobileViewportLock,
  mobileTerminalFrameStyle,
  restoreMobileViewportLock,
  shouldAllowMobileTerminalScroll,
} from "@/lib/terminal/mobile-shell-layout";
import { cn } from "@/lib/utils";

export const MOBILE_TERMINAL_SHELL_CLASS_NAME =
  "terminal-mobile-shell fixed inset-x-0 top-[calc(var(--safe-area-inset-top)+3.5rem)] flex flex-col overflow-hidden overscroll-none bg-background";

interface MobileTerminalShellProps {
  children: ReactNode;
  className?: string;
  diagnosticsEnabled?: boolean;
  isKeyboardVisible: boolean;
}

function useMobileTerminalViewportLock(isKeyboardVisible: boolean) {
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;

    const snapshot = applyMobileViewportLock(document, isKeyboardVisible);
    const blockPageScroll = (event: Event) => {
      if (shouldAllowMobileTerminalScroll(event.target)) return;
      event.preventDefault();
    };
    document.addEventListener("touchmove", blockPageScroll, { capture: true, passive: false });
    document.addEventListener("wheel", blockPageScroll, { capture: true, passive: false });

    return () => {
      document.removeEventListener("touchmove", blockPageScroll, { capture: true });
      document.removeEventListener("wheel", blockPageScroll, { capture: true });
      restoreMobileViewportLock(snapshot);
    };
  }, [isKeyboardVisible]);
}

export function MobileTerminalShell({
  children,
  className,
  diagnosticsEnabled = false,
  isKeyboardVisible,
}: MobileTerminalShellProps) {
  useMobileTerminalViewportLock(isKeyboardVisible);

  return (
    <div
      data-testid="terminal-mobile-shell"
      data-terminal-shell="true"
      className={cn(MOBILE_TERMINAL_SHELL_CLASS_NAME, className)}
      style={mobileTerminalFrameStyle(isKeyboardVisible)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
      <MobileTerminalDiagnosticsOverlay enabled={diagnosticsEnabled} />
    </div>
  );
}
