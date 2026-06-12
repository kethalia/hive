"use client";

import { type PointerEvent, useCallback, useRef } from "react";
import { ComposePanel } from "@/components/terminal/ComposePanel";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { COMPOSE_SHEET_DISMISS_DRAG_PX } from "@/lib/terminal/config";
import { composeSheetKeyboardStyle } from "@/lib/terminal/mobile-shell-layout";
import { cn } from "@/lib/utils";

interface TerminalSessionComposeProps {
  initialDraft?: string;
  isKeyboardVisible?: boolean;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
  onSend?: (draft: string) => void;
  open?: boolean;
  targetLabel?: string;
  variant: "inline" | "sheet";
  className?: string;
  dataTestId?: string;
}

export function TerminalSessionCompose({
  className,
  dataTestId,
  initialDraft = "",
  isKeyboardVisible = false,
  onClose,
  onOpenChange,
  onSend,
  open = false,
  targetLabel,
  variant,
}: TerminalSessionComposeProps) {
  const composeSheetDragStartYRef = useRef<number | null>(null);

  const handleComposeSheetDragStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    composeSheetDragStartYRef.current = event.clientY;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }, []);

  const handleComposeSheetDragEnd = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const startY = composeSheetDragStartYRef.current;
      composeSheetDragStartYRef.current = null;

      if (typeof event.currentTarget.releasePointerCapture === "function") {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (startY === null) return;
      if (event.clientY - startY >= COMPOSE_SHEET_DISMISS_DRAG_PX) {
        onClose();
      }
    },
    [onClose],
  );

  const handleComposeSheetDragCancel = useCallback(() => {
    composeSheetDragStartYRef.current = null;
  }, []);

  if (variant === "sheet") {
    return (
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => {
          if (onOpenChange) {
            onOpenChange(nextOpen);
            return;
          }
          if (!nextOpen) onClose();
        }}
      >
        <SheetContent
          side="bottom"
          className="h-[var(--app-viewport-height)] max-h-[var(--app-viewport-height)] p-0 pt-safe"
          style={composeSheetKeyboardStyle(isKeyboardVisible)}
        >
          <button
            type="button"
            aria-label="Dismiss compose panel"
            className="mx-auto mt-2 flex h-11 w-20 touch-none items-center justify-center rounded-full text-muted-foreground hover:text-foreground active:cursor-grabbing"
            onClick={onClose}
            onPointerCancel={handleComposeSheetDragCancel}
            onPointerDown={handleComposeSheetDragStart}
            onPointerUp={handleComposeSheetDragEnd}
          >
            <span className="h-1 w-10 rounded-full bg-current opacity-40" />
          </button>
          <SheetTitle className="sr-only">Compose command</SheetTitle>
          <div className="min-h-0 flex-1">
            <ComposePanel
              hideHeader
              initialDraft={initialDraft}
              targetLabel={targetLabel}
              onSend={onSend}
              onClose={onClose}
            />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-primary bg-black shadow-sm ring-1 ring-primary",
        className,
      )}
      data-testid={dataTestId}
    >
      <ComposePanel
        initialDraft={initialDraft}
        targetLabel={targetLabel}
        onSend={onSend}
        onClose={onClose}
      />
    </div>
  );
}
