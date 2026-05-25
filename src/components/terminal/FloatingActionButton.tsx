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
  CornerDownLeft,
  Plus,
  Minus,
} from "lucide-react";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useFabPosition, type Corner } from "@/hooks/useFabPosition";
import { useFabKeyboardOffset } from "@/hooks/useFabKeyboardOffset";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { VIRTUAL_KEY_SEQUENCES } from "@/lib/terminal/virtual-keys";

const GRID_KEYS = [
  { label: "Up", icon: ArrowUp, sequence: VIRTUAL_KEY_SEQUENCES.Up },
  { label: "Down", icon: ArrowDown, sequence: VIRTUAL_KEY_SEQUENCES.Down },
  { label: "Left", icon: ArrowLeft, sequence: VIRTUAL_KEY_SEQUENCES.Left },
  { label: "Right", icon: ArrowRight, sequence: VIRTUAL_KEY_SEQUENCES.Right },
  { label: "Esc", icon: Terminal, sequence: VIRTUAL_KEY_SEQUENCES.Esc },
  { label: "Ctrl+C", icon: X, sequence: VIRTUAL_KEY_SEQUENCES.CtrlC },
] as const;

const DESKTOP_KEYS = [
  { label: "Tab", icon: Keyboard, sequence: VIRTUAL_KEY_SEQUENCES.Tab },
  { label: "Up", icon: ArrowUp, sequence: VIRTUAL_KEY_SEQUENCES.Up },
  { label: "Down", icon: ArrowDown, sequence: VIRTUAL_KEY_SEQUENCES.Down },
  { label: "Right", icon: ArrowRight, sequence: VIRTUAL_KEY_SEQUENCES.Right },
  { label: "Left", icon: ArrowLeft, sequence: VIRTUAL_KEY_SEQUENCES.Left },
  { label: "Ctrl+C", icon: X, sequence: VIRTUAL_KEY_SEQUENCES.CtrlC },
  { label: "Esc", icon: Terminal, sequence: VIRTUAL_KEY_SEQUENCES.Esc },
] as const;

const QUICK_BAR_KEYS = [
  { label: "Enter", icon: CornerDownLeft, sequence: VIRTUAL_KEY_SEQUENCES.Enter },
  { label: "Tab", icon: Keyboard, sequence: VIRTUAL_KEY_SEQUENCES.Tab },
  { label: "Ctrl+C", icon: X, sequence: VIRTUAL_KEY_SEQUENCES.CtrlC },
] as const;

function menuDirection(corner: Corner): { horizontal: string; vertical: string } {
  const isLeft = corner.includes("left");
  const isTop = corner.includes("top");
  return {
    horizontal: isLeft ? "left-0" : "right-0",
    vertical: isTop ? "top-full mt-2" : "bottom-full mb-2",
  };
}

function quickBarDirection(corner: Corner): string {
  // Anchor the persistent pill on the opposite vertical edge of the FAB so it
  // sits ~12px away from the FAB in the same horizontal corner.
  const isTop = corner.includes("top");
  return isTop ? "top-full mt-3" : "bottom-full mb-3";
}

export interface FloatingActionButtonProps {
  /**
   * Haptic-feedback seam: called once when the reposition long-press arms,
   * and once for each virtual-key press from the grid or persistent quick
   * bar. Default no-op; S08 wires this to navigator.vibrate(10).
   */
  onHapticFeedback?: () => void;
}

export function FloatingActionButton({ onHapticFeedback }: FloatingActionButtonProps = {}) {
  const { activeSend } = useKeybindings();
  const haptic = useCallback(() => {
    onHapticFeedback?.();
  }, [onHapticFeedback]);
  const { corner, position, isDragging, isSnapping, onPointerDown, onPointerMove, onPointerUp } =
    useFabPosition({ onArmed: haptic });
  const { liftPx } = useFabKeyboardOffset();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const {
    size: fontSize,
    increase: increaseFontSize,
    decrease: decreaseFontSize,
    canIncrease,
    canDecrease,
  } = useTerminalFontStep();
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerUp = useCallback(() => {
    const wasDrag = onPointerUp();
    if (!wasDrag) {
      setExpanded((prev) => !prev);
    }
  }, [onPointerUp]);

  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", handleClickOutside);
    return () => document.removeEventListener("pointerdown", handleClickOutside);
  }, [expanded]);

  const sendKey = useCallback(
    (sequence: string) => {
      haptic();
      activeSend?.(sequence);
    },
    [activeSend, haptic],
  );

  const dir = menuDirection(corner);
  const quickDir = quickBarDirection(corner);

  return (
    <div
      ref={containerRef}
      className="fixed z-40 pb-safe px-safe"
      style={{
        transform: `translate3d(${position.x}px, ${position.y - liftPx}px, 0)`,
        transition: isSnapping ? "transform 200ms ease-out" : isDragging ? "none" : undefined,
        touchAction: "none",
        top: 0,
        left: 0,
        ...NO_TOUCH_STYLE,
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

      {isMobile && (
        <div className={`absolute ${quickDir} ${dir.horizontal} flex flex-col gap-2`}>
          <div
            className="flex items-center gap-2 rounded-full border bg-popover px-2 py-1 shadow-lg"
            role="toolbar"
            aria-label="Quick keys"
          >
            {QUICK_BAR_KEYS.map(({ label, icon: Icon, sequence }) => (
              <button
                key={label}
                type="button"
                className="flex h-11 w-11 items-center justify-center rounded-full text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                style={NO_TOUCH_STYLE}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => sendKey(sequence)}
                aria-label={label}
              >
                <Icon className="h-5 w-5" />
              </button>
            ))}
          </div>
          <div
            className="flex items-center justify-between gap-2 rounded-full border bg-popover px-2 py-1 shadow-lg"
            role="toolbar"
            aria-label="Terminal font size"
          >
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
              style={NO_TOUCH_STYLE}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={decreaseFontSize}
              disabled={!canDecrease}
              aria-label="Decrease font size"
            >
              <Minus className="h-5 w-5" />
            </button>
            <span className="text-xs tabular-nums text-popover-foreground select-none min-w-[3ch] text-center">
              {fontSize}
            </span>
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-full text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
              style={NO_TOUCH_STYLE}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={increaseFontSize}
              disabled={!canIncrease}
              aria-label="Increase font size"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {expanded && isMobile && (
        <div
          className={`absolute ${dir.vertical} ${dir.horizontal} flex flex-col gap-2 rounded-lg border bg-popover p-2 shadow-xl`}
          role="menu"
          aria-label="Virtual keys"
        >
          <div className="grid grid-cols-2 gap-2">
            {GRID_KEYS.map(({ label, icon: Icon, sequence }) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className="flex h-11 w-11 items-center justify-center rounded-md text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                style={NO_TOUCH_STYLE}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => sendKey(sequence)}
                aria-label={label}
              >
                <Icon className="h-5 w-5" />
              </button>
            ))}
          </div>
        </div>
      )}

      {expanded && !isMobile && (
        <div
          className={`absolute ${dir.vertical} ${dir.horizontal} flex flex-col gap-1 rounded-lg border bg-popover p-2 shadow-xl`}
          role="menu"
          aria-label="Virtual keys"
        >
          {DESKTOP_KEYS.map(({ label, icon: Icon, sequence }) => (
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
          <hr className="my-1 h-px border-0 bg-border" />
          <div className="flex items-center justify-between gap-2 px-3 py-1">
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-8 items-center justify-center rounded-md text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={decreaseFontSize}
              disabled={!canDecrease}
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
              disabled={!canIncrease}
              aria-label="Increase font size"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <hr className="my-1 h-px border-0 bg-border" />
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => sendKey(VIRTUAL_KEY_SEQUENCES.Enter)}
          >
            <CornerDownLeft className="h-4 w-4" />
            Enter
          </button>
        </div>
      )}
    </div>
  );
}
