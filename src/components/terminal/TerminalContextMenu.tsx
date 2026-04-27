"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, ClipboardPaste, Plus, X } from "lucide-react";

interface TerminalContextMenuProps {
  position: { x: number; y: number } | null;
  onClose: () => void;
  hasSelection: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onNewSession?: () => void;
  onCloseSession?: () => void;
}

export function TerminalContextMenu({
  position,
  onClose,
  hasSelection,
  onCopy,
  onPaste,
  onNewSession,
  onCloseSession,
}: TerminalContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;

    function handleMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    function handleScroll() {
      onClose();
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [position, onClose]);

  if (!position) return null;

  const clampedX = Math.min(position.x, window.innerWidth - 200);
  const clampedY = Math.min(position.y, window.innerHeight - 200);

  const hasSessionActions = onNewSession || onCloseSession;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-border"
      style={{ left: clampedX, top: clampedY }}
    >
      <button
        type="button"
        disabled={!hasSelection}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
        onClick={() => {
          onCopy();
          onClose();
        }}
      >
        <Copy className="size-4" />
        Copy
        <span className="ml-auto text-xs text-muted-foreground">Ctrl+C</span>
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
        onClick={() => {
          onPaste();
          onClose();
        }}
      >
        <ClipboardPaste className="size-4" />
        Paste
        <span className="ml-auto text-xs text-muted-foreground">Ctrl+V</span>
      </button>
      {hasSessionActions && (
        <>
          <div className="my-1 h-px bg-border" />
          {onNewSession && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                onNewSession();
                onClose();
              }}
            >
              <Plus className="size-4" />
              New Session
            </button>
          )}
          {onCloseSession && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground hover:text-destructive"
              onClick={() => {
                onCloseSession();
                onClose();
              }}
            >
              <X className="size-4" />
              Close Session
            </button>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
