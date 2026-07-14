"use client";

import { Lock, Minus, Plus, X } from "lucide-react";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
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
  className?: string;
}

export function SingleTerminalSessionHeader({
  sessionLabel,
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
        <p className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="active-pane-label">
          {sessionLabel}
        </p>
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
  active?: boolean;
  className?: string;
  contentClassName?: string;
  dataTestId?: string;
  layoutMode?: "single" | "tiled";
  showHeader?: boolean;
  onActivate?: () => void;
  onClose?: (event: MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: () => void;
  onFocusActivate?: boolean;
  disabled?: boolean;
  disabledLabel?: string;
  closeLabel?: string;
  closeTestId?: string;
  style?: CSSProperties;
}

export function TerminalSessionFrame({
  children,
  label,
  active = true,
  className,
  contentClassName,
  dataTestId,
  layoutMode = "single",
  showHeader = true,
  onActivate,
  onClose,
  onMouseEnter,
  onFocusActivate = false,
  disabled = false,
  disabledLabel,
  closeLabel,
  closeTestId,
  style,
}: TerminalSessionFrameProps) {
  const interactive = Boolean(onActivate) && !disabled;

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

  return (
    <div
      role={interactive ? "button" : "group"}
      className={cn(
        "relative flex min-h-0 resize-none flex-col overflow-hidden rounded-lg border bg-black shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary ring-1 ring-primary" : "border-border",
        disabled && "border-white/10 opacity-45 grayscale-[0.35] saturate-50",
        className,
      )}
      aria-disabled={disabled || undefined}
      data-active={active ? "true" : "false"}
      data-compose-disabled={disabled ? "true" : "false"}
      data-pane-label={label}
      data-pane-mode={layoutMode}
      data-testid={dataTestId}
      style={style}
      tabIndex={interactive ? 0 : undefined}
      onClick={handleFrameClick}
      onFocus={handleFrameFocus}
      onKeyDown={handleFrameKeyDown}
      onMouseEnter={disabled ? undefined : onMouseEnter}
    >
      {showHeader ? (
        <div
          className="flex min-h-8 shrink-0 items-center gap-1 border-b border-white/10 bg-zinc-950 px-2 py-1 text-white"
          data-testid={dataTestId ? `${dataTestId}-header` : undefined}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
          {onClose ? (
            <Button
              type="button"
              variant="destructive"
              size="xs"
              className="h-6 min-h-0 px-1.5 text-[10px]"
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
