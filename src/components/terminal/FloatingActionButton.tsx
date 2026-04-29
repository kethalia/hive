"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Terminal,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  X,
  Keyboard,
  Send,
  Plus,
  Minus,
} from "lucide-react";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useFabPosition, type Corner } from "@/hooks/useFabPosition";
import {
  getTerminalFontSize,
  setTerminalFontSize,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  EVENT_NAME,
} from "@/lib/terminal/font-size";

const VIRTUAL_KEYS = [
  { label: "Tab", icon: Keyboard, sequence: "\t" },
  { label: "Up", icon: ArrowUp, sequence: "\x1b[A" },
  { label: "Down", icon: ArrowDown, sequence: "\x1b[B" },
  { label: "Right", icon: ArrowRight, sequence: "\x1b[C" },
  { label: "Left", icon: ArrowLeft, sequence: "\x1b[D" },
  { label: "Ctrl+C", icon: X, sequence: "\x03" },
  { label: "Esc", icon: Terminal, sequence: "\x1b" },
] as const;

function menuDirection(corner: Corner): { horizontal: string; vertical: string } {
  const isLeft = corner.includes("left");
  const isTop = corner.includes("top");
  return {
    horizontal: isLeft ? "left-0" : "right-0",
    vertical: isTop ? "top-full mt-2" : "bottom-full mb-2",
  };
}

export function FloatingActionButton() {
  const { activeSend } = useKeybindings();
  const {
    corner,
    position,
    isDragging,
    isSnapping,
    dragDist,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  } = useFabPosition();
  const [expanded, setExpanded] = useState(false);
  const [fontSize, setFontSize] = useState(getTerminalFontSize);
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const wasDrag = onPointerUp();
      if (!wasDrag) {
        setExpanded((prev) => !prev);
      }
    },
    [onPointerUp],
  );

  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", handleClickOutside);
    return () => document.removeEventListener("pointerdown", handleClickOutside);
  }, [expanded]);

  useEffect(() => {
    const handler = (e: Event) => setFontSize((e as CustomEvent<number>).detail);
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  const increaseFontSize = useCallback(() => {
    setTerminalFontSize(getTerminalFontSize() + 1);
  }, []);

  const decreaseFontSize = useCallback(() => {
    setTerminalFontSize(getTerminalFontSize() - 1);
  }, []);

  const sendKey = useCallback(
    (sequence: string) => {
      activeSend?.(sequence);
    },
    [activeSend],
  );

  const dir = menuDirection(corner);

  return (
    <div
      ref={containerRef}
      className="fixed z-40"
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        transition: isSnapping ? "transform 200ms ease-out" : isDragging ? "none" : undefined,
        touchAction: "none",
        top: 0,
        left: 0,
      }}
    >
      <button
        type="button"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:scale-95 transition-transform"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={handlePointerUp}
        aria-label={expanded ? "Close virtual keyboard" : "Open virtual keyboard"}
        aria-expanded={expanded}
      >
        <Terminal className="h-6 w-6" />
      </button>

      {expanded && (
        <div
          className={`absolute ${dir.vertical} ${dir.horizontal} flex flex-col gap-1 rounded-lg border bg-popover p-2 shadow-xl`}
          role="menu"
          aria-label="Virtual keys"
        >
          {VIRTUAL_KEYS.map(({ label, icon: Icon, sequence }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => sendKey(sequence)}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
          <div className="my-1 h-px bg-border" role="separator" />
          <div className="flex items-center justify-between gap-2 px-3 py-1" role="group" aria-label="Font size">
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-8 items-center justify-center rounded-md text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={decreaseFontSize}
              disabled={fontSize <= MIN_FONT_SIZE}
              aria-label="Decrease font size"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="text-xs tabular-nums text-popover-foreground select-none min-w-[3ch] text-center">
              {fontSize}
            </span>
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-8 items-center justify-center rounded-md text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={increaseFontSize}
              disabled={fontSize >= MAX_FONT_SIZE}
              aria-label="Increase font size"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <div className="my-1 h-px bg-border" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => sendKey("\r")}
          >
            <Send className="h-4 w-4" />
            Send
          </button>
        </div>
      )}
    </div>
  );
}
