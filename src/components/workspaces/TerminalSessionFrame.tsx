"use client";

import { Ellipsis, GripVertical, Lock, Minus, Plus, X } from "lucide-react";
import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  PointerEventHandler,
  ReactNode,
  TouchEvent,
} from "react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { triggerHapticFeedback } from "@/lib/device/haptics";
import { DRAG_LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from "@/lib/gestures/conventions";
import { cn } from "@/lib/utils";

interface TerminalFontSizeControlsProps {
  className?: string;
  dataTestId?: string;
  decreaseTestId?: string;
  increaseTestId?: string;
  label?: string;
}

export function TerminalFontSizeControls({
  className,
  dataTestId = "terminal-font-size-controls",
  decreaseTestId = "decrease-terminal-font-size",
  increaseTestId = "increase-terminal-font-size",
  label = "Terminal font size controls",
}: TerminalFontSizeControlsProps) {
  const {
    size: fontSize,
    increase: increaseFontSize,
    decrease: decreaseFontSize,
    canIncrease: canIncreaseFontSize,
    canDecrease: canDecreaseFontSize,
  } = useTerminalFontStep();

  return (
    <fieldset
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-md border border-border px-1 py-0.5",
        className,
      )}
      data-testid={dataTestId}
    >
      <legend className="sr-only">{label}</legend>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-6 min-h-0 px-1.5 text-[10px]"
        onClick={decreaseFontSize}
        disabled={!canDecreaseFontSize}
        aria-label="Decrease terminal font size"
        data-testid={decreaseTestId}
      >
        <Minus className="size-3" />
      </Button>
      <span className="min-w-10 text-center text-[10px] tabular-nums text-muted-foreground">
        {fontSize}px
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-6 min-h-0 px-1.5 text-[10px]"
        onClick={increaseFontSize}
        disabled={!canIncreaseFontSize}
        aria-label="Increase terminal font size"
        data-testid={increaseTestId}
      >
        <Plus className="size-3" />
      </Button>
    </fieldset>
  );
}

interface SingleTerminalSessionHeaderProps {
  sessionLabel: string;
  sessionSubtitle?: string;
  className?: string;
}

export function SingleTerminalSessionHeader({
  sessionLabel,
  sessionSubtitle,
  className,
}: SingleTerminalSessionHeaderProps) {
  return (
    <header
      className={cn(
        "grid min-h-[calc(3.5rem+var(--safe-area-inset-top))] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-b border-sidebar-border px-[max(0.25rem,var(--safe-area-inset-left))] pb-1 pt-[calc(var(--safe-area-inset-top)+0.25rem)] pr-[max(0.25rem,var(--safe-area-inset-right))] min-[1025px]:min-h-14 min-[1025px]:py-1",
        className,
      )}
      data-testid="single-terminal-header"
    >
      <div className="flex min-w-0 items-center gap-1" data-testid="single-terminal-header-left">
        <SidebarTrigger className="h-7 min-h-0 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs" data-testid="active-pane-label">
            {sessionLabel}
          </span>
          {sessionSubtitle ? (
            <span
              className="block truncate font-mono text-[10px] text-muted-foreground"
              data-testid="active-pane-subtitle"
            >
              {sessionSubtitle}
            </span>
          ) : null}
        </span>
      </div>
      <div
        className="flex min-w-0 items-center justify-end gap-1"
        data-testid="single-terminal-header-right"
      >
        <TerminalFontSizeControls label="Single terminal font size controls" />
      </div>
    </header>
  );
}

interface TerminalSessionFrameProps {
  children: ReactNode;
  label: string;
  subtitle?: string;
  active?: boolean;
  className?: string;
  contentClassName?: string;
  dataTestId?: string;
  layoutMode?: "single" | "tiled";
  showHeader?: boolean;
  onActivate?: () => void;
  onClose?: (event: MouseEvent<HTMLButtonElement>) => void;
  onMouseMove?: () => void;
  onFocusActivate?: boolean;
  disabled?: boolean;
  disabledLabel?: string;
  closeLabel?: string;
  closeTestId?: string;
  headerActions?: ReactNode;
  onHeaderPointerDown?: PointerEventHandler<HTMLDivElement>;
  onOpenActions?: () => void;
  touchOptimizedActions?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  style?: CSSProperties;
  paneState?: string;
}

export function TerminalSessionFrame({
  children,
  label,
  subtitle,
  active = true,
  className,
  contentClassName,
  dataTestId,
  layoutMode = "single",
  showHeader = true,
  onActivate,
  onClose,
  onMouseMove,
  onFocusActivate = false,
  disabled = false,
  disabledLabel,
  closeLabel,
  closeTestId,
  headerActions,
  onHeaderPointerDown,
  onOpenActions,
  touchOptimizedActions = false,
  isDragging = false,
  isDropTarget = false,
  style,
  paneState,
}: TerminalSessionFrameProps) {
  const interactive = Boolean(onActivate) && !disabled;
  const longPressTimerRef = useRef<number | null>(null);
  const longPressReadyRef = useRef(false);
  const longPressTouchRef = useRef<{ id: number; x: number; y: number } | null>(null);

  function clearHeaderLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressReadyRef.current = false;
    longPressTouchRef.current = null;
  }

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    },
    [],
  );

  function handleFrameClick(event: MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    if (!onActivate) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("[data-terminal-surface='true']")) return;
    onActivate();
  }

  function handleFrameFocus(event: FocusEvent<HTMLDivElement>) {
    if (disabled) return;
    if (!onFocusActivate || event.currentTarget !== event.target) return;
    onActivate?.();
  }

  function handleFrameKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (!interactive || event.currentTarget !== event.target) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate?.();
  }

  function handleHeaderPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const target = event.target;
    const interactiveTarget =
      target instanceof Element
        ? target.closest("button, a, input, select, textarea, [role='button'], [role='link']")
        : null;
    if (interactiveTarget && event.currentTarget.contains(interactiveTarget)) {
      return;
    }

    onHeaderPointerDown?.(event);
  }

  function handleHeaderTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (disabled || !onOpenActions || event.touches.length !== 1) return;
    const target = event.target;
    const interactiveTarget =
      target instanceof Element
        ? target.closest("button, a, input, select, textarea, [role='button'], [role='link']")
        : null;
    if (interactiveTarget && event.currentTarget.contains(interactiveTarget)) return;

    const touch = event.touches[0];
    clearHeaderLongPress();
    longPressTouchRef.current = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
    };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressReadyRef.current = true;
      triggerHapticFeedback();
    }, LONG_PRESS_MS);
  }

  function handleHeaderTouchMove(event: TouchEvent<HTMLDivElement>) {
    const start = longPressTouchRef.current;
    if (!start) return;
    const touch = Array.from(event.touches).find((candidate) => candidate.identifier === start.id);
    if (
      !touch ||
      Math.hypot(touch.clientX - start.x, touch.clientY - start.y) >= DRAG_LONG_PRESS_MOVE_PX
    ) {
      clearHeaderLongPress();
    }
  }

  function handleHeaderTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const shouldOpenActions = longPressReadyRef.current;
    clearHeaderLongPress();
    if (!shouldOpenActions || !onOpenActions) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    onOpenActions();
  }

  function handleHeaderContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (disabled || !onOpenActions) return;
    const target = event.target;
    const interactiveTarget =
      target instanceof Element
        ? target.closest("button, a, input, select, textarea, [role='button'], [role='link']")
        : null;
    if (interactiveTarget && event.currentTarget.contains(interactiveTarget)) {
      return;
    }
    event.preventDefault();
    onOpenActions();
  }

  return (
    <div
      role={interactive ? "button" : "group"}
      className={cn(
        "relative flex h-full min-h-0 resize-none flex-col overflow-hidden border bg-black shadow-sm outline-none transition-[border-color,box-shadow,opacity] focus-visible:ring-2 focus-visible:ring-ring",
        layoutMode === "single" ? "rounded-lg" : "rounded-md",
        active ? "border-primary ring-1 ring-primary" : "border-border",
        isDropTarget && "border-primary/80 ring-2 ring-inset ring-primary/60",
        isDragging && "shadow-xl shadow-black/40",
        disabled && "border-white/10 opacity-45 grayscale-[0.35] saturate-50",
        className,
      )}
      aria-disabled={disabled || undefined}
      data-active={active ? "true" : "false"}
      data-compose-disabled={disabled ? "true" : "false"}
      data-pane-label={label}
      data-pane-mode={layoutMode}
      data-pane-state={paneState}
      data-testid={dataTestId}
      style={style}
      tabIndex={interactive ? 0 : undefined}
      onClick={handleFrameClick}
      onFocus={handleFrameFocus}
      onKeyDown={handleFrameKeyDown}
      onMouseMove={disabled ? undefined : onMouseMove}
    >
      {showHeader ? (
        <div
          className={cn(
            "flex min-h-10 shrink-0 select-none items-center gap-1 border-b border-white/10 bg-zinc-950 px-2 text-white",
            !disabled && onHeaderPointerDown && "touch-none cursor-grab active:cursor-grabbing",
          )}
          data-window-drag-surface={!disabled && onHeaderPointerDown ? "true" : "false"}
          data-testid={dataTestId ? `${dataTestId}-header` : undefined}
          onContextMenu={handleHeaderContextMenu}
          onPointerDown={handleHeaderPointerDown}
          onTouchStart={handleHeaderTouchStart}
          onTouchMove={handleHeaderTouchMove}
          onTouchEnd={handleHeaderTouchEnd}
          onTouchCancel={clearHeaderLongPress}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {!disabled && onHeaderPointerDown ? (
              <GripVertical
                className="size-3 shrink-0 text-white/55"
                aria-hidden="true"
                data-testid={dataTestId ? `${dataTestId}-drag-icon` : undefined}
              />
            ) : null}
            <span className="min-w-0 flex-1">
              <span
                className="block truncate font-mono text-xs"
                data-testid={dataTestId ? `${dataTestId}-title` : undefined}
              >
                {label}
              </span>
              {subtitle ? (
                <span
                  className="block truncate font-mono text-[10px] text-white/55"
                  data-testid={dataTestId ? `${dataTestId}-subtitle` : undefined}
                >
                  {subtitle}
                </span>
              ) : null}
            </span>
          </div>
          {headerActions}
          {onOpenActions ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={cn(
                "shrink-0 text-white hover:bg-white/10 hover:text-white",
                touchOptimizedActions ? "size-11 min-h-11 px-0" : "h-6 min-h-0 px-1.5",
              )}
              aria-label={`Open actions for ${label}`}
              data-testid={dataTestId ? `${dataTestId}-actions` : undefined}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onOpenActions();
              }}
            >
              <Ellipsis className="size-3" />
            </Button>
          ) : null}
          {onClose ? (
            <Button
              type="button"
              variant="destructive"
              size="xs"
              className={cn(
                "text-[10px]",
                touchOptimizedActions ? "size-11 min-h-11 px-0" : "h-6 min-h-0 px-1.5",
              )}
              aria-label={closeLabel ?? `Close ${label}`}
              data-testid={closeTestId}
              disabled={disabled}
              onClick={onClose}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          disabled && "pointer-events-none",
          contentClassName,
        )}
        data-terminal-frame-content="true"
      >
        {children}
      </div>
      {disabled ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-start justify-end bg-black/35 p-2"
          data-testid={dataTestId ? `${dataTestId}-disabled-overlay` : undefined}
        >
          <span className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/80 px-2 py-1 font-mono text-[10px] text-white/80 shadow-sm">
            <Lock className="size-3" />
            {disabledLabel ?? "Compose locked"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
