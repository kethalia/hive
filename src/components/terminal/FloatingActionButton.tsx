"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Keyboard,
  Minus,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useFabKeyboardOffset } from "@/hooks/useFabKeyboardOffset";
import { type Corner, useFabPosition } from "@/hooks/useFabPosition";
import { useKeybindings } from "@/hooks/useKeybindings";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { VIRTUAL_KEY_SEQUENCES } from "@/lib/terminal/virtual-keys";

const GRID_KEYS = [
  { label: "Up", icon: ArrowUp, sequence: VIRTUAL_KEY_SEQUENCES.Up },
  { label: "Down", icon: ArrowDown, sequence: VIRTUAL_KEY_SEQUENCES.Down },
  { label: "Left", icon: ArrowLeft, sequence: VIRTUAL_KEY_SEQUENCES.Left },
  { label: "Right", icon: ArrowRight, sequence: VIRTUAL_KEY_SEQUENCES.Right },
  { label: "Esc", icon: Terminal, sequence: VIRTUAL_KEY_SEQUENCES.Esc },
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

function mobilePanelDirection(corner: Corner): string {
  const horizontal = corner.includes("left")
    ? "left-[calc(var(--safe-area-inset-left)+1rem)]"
    : "right-[calc(var(--safe-area-inset-right)+1rem)]";
  const vertical = corner.includes("top")
    ? "top-[calc(var(--safe-area-inset-top)+5rem)]"
    : "bottom-[calc(var(--safe-area-inset-bottom)+5rem)]";
  return `${horizontal} ${vertical}`;
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
  const {
    corner,
    position,
    isDragging,
    isSnapping,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  } = useFabPosition({ onArmed: haptic });
  const { liftPx } = useFabKeyboardOffset();
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const {
    size: fontSize,
    increase: increaseFontSize,
    decrease: decreaseFontSize,
    canIncrease,
    canDecrease,
  } = useTerminalFontStep();
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const wasDrag = onPointerUp(event);
      if (!wasDrag) {
        setExpanded((prev) => !prev);
      }
    },
    [onPointerUp],
  );

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
  const mobilePanelPosition = mobilePanelDirection(corner);
  let containerTransition: string | undefined;
  if (isDragging || (prefersReducedMotion && isSnapping)) {
    containerTransition = "none";
  } else if (isSnapping) {
    containerTransition = "transform 200ms ease-out";
  }

  return (
    <div
      ref={containerRef}
      className="fixed z-40 pb-safe px-safe"
      style={{
        transform: `translate3d(${position.x}px, ${position.y - liftPx}px, 0)`,
        transition: containerTransition,
        touchAction: "none",
        top: 0,
        left: 0,
        ...NO_TOUCH_STYLE,
      }}
    >
      <button
        type="button"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:scale-95 transition-transform motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:active:scale-100"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={onPointerCancel}
        aria-label={expanded ? "Close virtual keyboard" : "Open virtual keyboard"}
        aria-expanded={expanded}
      >
        <Terminal className="h-6 w-6" />
      </button>

      {expanded && isMobile && (
        <div
          className={`fixed ${mobilePanelPosition} z-50 flex max-h-[calc(100dvh-var(--safe-area-inset-top)-var(--safe-area-inset-bottom)-2rem)] w-[min(calc(100vw-2rem),22rem)] max-w-[calc(100vw-var(--safe-area-inset-left)-var(--safe-area-inset-right)-2rem)] flex-col gap-3 overflow-y-auto rounded-2xl border bg-popover p-3 text-popover-foreground shadow-2xl`}
          role="menu"
          aria-label="Virtual keys"
        >
          <section aria-label="Quick keys" className="space-y-2">
            <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Quick keys
            </p>
            <div className="grid grid-cols-3 gap-2">
              {QUICK_BAR_KEYS.map(({ label, icon: Icon, sequence }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-xl bg-accent/60 px-2 py-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none motion-reduce:duration-0"
                  style={NO_TOUCH_STYLE}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => sendKey(sequence)}
                  aria-label={label}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>

          <section aria-label="Navigation keys" className="space-y-2">
            <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Navigation
            </p>
            <div className="grid grid-cols-3 gap-2">
              {GRID_KEYS.map(({ label, icon: Icon, sequence }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none motion-reduce:duration-0"
                  style={NO_TOUCH_STYLE}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => sendKey(sequence)}
                  aria-label={label}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>

          <section aria-label="Terminal font size" className="space-y-2">
            <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Font size
            </p>
            <div className="grid grid-cols-[2.75rem_1fr_2.75rem] items-center gap-2 rounded-xl bg-muted/50 p-1">
              <button
                type="button"
                className="flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:duration-0"
                style={NO_TOUCH_STYLE}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={decreaseFontSize}
                disabled={!canDecrease}
                aria-label="Decrease font size"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="select-none text-center text-sm tabular-nums">{fontSize}px</span>
              <button
                type="button"
                className="flex h-11 w-11 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:duration-0"
                style={NO_TOUCH_STYLE}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={increaseFontSize}
                disabled={!canIncrease}
                aria-label="Increase font size"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </section>
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
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap motion-reduce:transition-none motion-reduce:duration-0"
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
              className="flex h-8 w-8 items-center justify-center rounded-md text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none motion-reduce:transition-none motion-reduce:duration-0"
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
              className="flex h-8 w-8 items-center justify-center rounded-md text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none motion-reduce:transition-none motion-reduce:duration-0"
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
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap motion-reduce:transition-none motion-reduce:duration-0"
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
