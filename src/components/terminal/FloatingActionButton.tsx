"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Ellipsis,
  Keyboard,
  MessageSquareText,
  Minus,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { useIsMobile } from "@/hooks/use-mobile";
import { type Corner, useFabPosition } from "@/hooks/useFabPosition";
import { useKeybindings } from "@/hooks/useKeybindings";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";
import { VIRTUAL_KEY_SEQUENCES } from "@/lib/terminal/virtual-keys";

const NAVIGATION_KEYS = [
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

const QUICK_ROW_KEYS = [
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

export interface FloatingActionButtonProps {
  /**
   * Haptic-feedback seam: called once when the reposition long-press arms,
   * and once for each terminal action press. Default no-op; S08 wires this
   * to navigator.vibrate(10).
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

  const handleDesktopPointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const wasDrag = onPointerUp(event);
      if (!wasDrag) {
        setExpanded((prev) => !prev);
      }
    },
    [onPointerUp],
  );

  const toggleMobileMore = useCallback(() => {
    haptic();
    setExpanded((prev) => !prev);
  }, [haptic]);

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

  const openCompose = useCallback(() => {
    haptic();
    window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_OPEN_EVENT));
    setExpanded(false);
  }, [haptic]);

  const dir = menuDirection(corner);
  let desktopTransition: string | undefined;
  if (isDragging || (prefersReducedMotion && isSnapping)) {
    desktopTransition = "none";
  } else if (isSnapping) {
    desktopTransition = "transform 200ms ease-out";
  }

  if (isMobile) {
    return (
      <div
        ref={containerRef}
        className="w-full border-t bg-background/95 px-safe pt-2 pb-[calc(var(--safe-area-inset-bottom)+0.5rem)] shadow-[0_-18px_40px_rgba(0,0,0,0.24)] backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{
          touchAction: "manipulation",
          ...NO_TOUCH_STYLE,
        }}
      >
        <div className="mx-auto flex w-full max-w-screen-sm flex-col gap-2 px-2">
          {expanded && (
            <div
              className="flex max-h-[min(42dvh,22rem)] w-full flex-col gap-3 overflow-y-auto rounded-2xl border bg-popover/95 p-3 text-popover-foreground shadow-2xl backdrop-blur"
              role="menu"
              aria-label="More terminal actions"
            >
              <Button
                type="button"
                role="menuitem"
                variant="outline"
                className="min-h-11 w-full justify-start rounded-xl"
                style={NO_TOUCH_STYLE}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={openCompose}
              >
                <MessageSquareText data-icon="inline-start" />
                Compose
              </Button>

              <section aria-label="Navigation keys" className="flex flex-col gap-2">
                <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Navigation
                </p>
                <ButtonGroup
                  aria-label="Terminal navigation keys"
                  className="grid w-full grid-cols-5"
                >
                  {NAVIGATION_KEYS.map(({ label, icon: Icon, sequence }) => (
                    <Button
                      key={label}
                      type="button"
                      role="menuitem"
                      variant="outline"
                      className="min-h-11 min-w-11 flex-col gap-1 rounded-xl px-2 py-2 text-xs"
                      style={NO_TOUCH_STYLE}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => sendKey(sequence)}
                    >
                      <Icon />
                      <span>{label}</span>
                    </Button>
                  ))}
                </ButtonGroup>
              </section>

              <section aria-label="Terminal font size" className="flex flex-col gap-2">
                <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Font size
                </p>
                <ButtonGroup aria-label="Terminal font size controls" className="w-full">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 min-w-11 flex-1"
                    style={NO_TOUCH_STYLE}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={decreaseFontSize}
                    disabled={!canDecrease}
                    aria-label="Decrease font size"
                  >
                    <Minus />
                  </Button>
                  <ButtonGroupText className="min-h-11 flex-1 justify-center tabular-nums">
                    {fontSize}px
                  </ButtonGroupText>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 min-w-11 flex-1"
                    style={NO_TOUCH_STYLE}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={increaseFontSize}
                    disabled={!canIncrease}
                    aria-label="Increase font size"
                  >
                    <Plus />
                  </Button>
                </ButtonGroup>
              </section>
            </div>
          )}

          <ButtonGroup
            aria-label="Terminal quick actions"
            className="grid w-full grid-cols-4 rounded-2xl border bg-background/95 p-1 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-background/80"
          >
            {QUICK_ROW_KEYS.map(({ label, icon: Icon, sequence }) => (
              <Button
                key={label}
                type="button"
                variant="ghost"
                className="min-h-12 min-w-0 rounded-xl px-1 text-xs"
                style={NO_TOUCH_STYLE}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => sendKey(sequence)}
              >
                <Icon data-icon="inline-start" />
                {label}
              </Button>
            ))}
            <Button
              type="button"
              variant={expanded ? "secondary" : "default"}
              className="min-h-12 min-w-0 rounded-xl px-1 text-xs"
              style={NO_TOUCH_STYLE}
              onClick={toggleMobileMore}
              aria-expanded={expanded}
            >
              <Ellipsis data-icon="inline-start" />
              More
            </Button>
          </ButtonGroup>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed z-40 pb-safe px-safe"
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        transition: desktopTransition,
        touchAction: "none",
        top: 0,
        left: 0,
        ...NO_TOUCH_STYLE,
      }}
    >
      <button
        type="button"
        className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:bg-primary/90 active:scale-95 motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:active:scale-100"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={handleDesktopPointerUp}
        onPointerCancel={onPointerCancel}
        aria-label={expanded ? "Close virtual keyboard" : "Open virtual keyboard"}
        aria-expanded={expanded}
      >
        <Terminal className="size-6" />
      </button>

      {expanded && (
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
              className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none motion-reduce:duration-0"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => sendKey(sequence)}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
          <hr className="my-1 h-px border-0 bg-border" />
          <div className="flex items-center justify-between gap-2 px-3 py-1">
            <button
              type="button"
              role="menuitem"
              className="flex size-8 items-center justify-center rounded-md text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:duration-0"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={decreaseFontSize}
              disabled={!canDecrease}
              aria-label="Decrease font size"
            >
              <Minus className="size-4" />
            </button>
            <span className="min-w-[3ch] select-none text-center text-xs tabular-nums text-popover-foreground">
              {fontSize}
            </span>
            <button
              type="button"
              role="menuitem"
              className="flex size-8 items-center justify-center rounded-md text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:duration-0"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={increaseFontSize}
              disabled={!canIncrease}
              aria-label="Increase font size"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <hr className="my-1 h-px border-0 bg-border" />
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none motion-reduce:duration-0"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => sendKey(VIRTUAL_KEY_SEQUENCES.Enter)}
          >
            <CornerDownLeft className="size-4" />
            Enter
          </button>
        </div>
      )}
    </div>
  );
}
