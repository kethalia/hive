"use client";

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { Ellipsis, GripVertical, Minus, Plus, X } from "lucide-react";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { ShortcutTooltip } from "@/components/ui/shortcut-tooltip";
import { WorkspaceSearchButton } from "@/components/workspaces/WorkspaceHeaderButton";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { PANE_CONTROL_SHORTCUTS } from "@/lib/keyboard-shortcuts";
import {
  TERMINAL_CLOSE_HOVER_CLASS_NAME,
  TERMINAL_CONTROL_BUTTON_CLASS_NAME,
  TERMINAL_CONTROL_HOVER_CLASS_NAME,
} from "@/lib/terminal/pane-controls";
import { cn } from "@/lib/utils";

interface TerminalFontSizeControlsProps {
  fontSizeScope: string;
  className?: string;
  dataTestId?: string;
  decreaseTestId?: string;
  increaseTestId?: string;
  label?: string;
}

export function TerminalFontSizeControls({
  fontSizeScope,
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
  } = useTerminalFontStep(fontSizeScope);

  return (
    <fieldset
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-md border border-border bg-background",
        className,
      )}
      data-testid={dataTestId}
    >
      <legend className="sr-only">{label}</legend>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-8 min-h-0 rounded-none"
        onClick={decreaseFontSize}
        disabled={!canDecreaseFontSize}
        aria-label="Decrease terminal font size"
        data-testid={decreaseTestId}
      >
        <Minus className="size-4" />
      </Button>
      <span className="min-w-12 text-center text-sm tabular-nums text-foreground">
        {fontSize}px
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-8 min-h-0 rounded-none"
        onClick={increaseFontSize}
        disabled={!canIncreaseFontSize}
        aria-label="Increase terminal font size"
        data-testid={increaseTestId}
      >
        <Plus className="size-4" />
      </Button>
    </fieldset>
  );
}

interface SingleTerminalSessionHeaderProps {
  fontSizeScope?: string;
  sessionLabel: string;
  sessionSubtitle?: string;
  className?: string;
  showFontSizeControls?: boolean;
}

export function SingleTerminalSessionHeader({
  fontSizeScope,
  sessionLabel,
  sessionSubtitle,
  className,
  showFontSizeControls = true,
}: SingleTerminalSessionHeaderProps) {
  return (
    <header
      className={cn(
        "grid min-h-[calc(3.5rem+var(--safe-area-inset-top))] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-b border-border px-[max(0.25rem,var(--safe-area-inset-left))] pb-1 pt-[calc(var(--safe-area-inset-top)+0.25rem)] pr-[max(0.25rem,var(--safe-area-inset-right))]",
        className,
      )}
      data-testid="single-terminal-header"
    >
      <div className="flex min-w-0 items-center gap-1" data-testid="single-terminal-header-left">
        <WorkspaceSearchButton />
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
        <div data-terminal-audio-slot="true" className="flex shrink-0" />
        {showFontSizeControls && fontSizeScope ? (
          <TerminalFontSizeControls
            fontSizeScope={fontSizeScope}
            label="Single terminal font size controls"
          />
        ) : null}
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
  closeLabel?: string;
  closeTestId?: string;
  headerActions?: ReactNode;
  dragHandleListeners?: DraggableSyntheticListeners;
  onOpenActions?: (anchor: HTMLButtonElement) => void;
  actionsOpen?: boolean;
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
  closeLabel,
  closeTestId,
  headerActions,
  dragHandleListeners,
  onOpenActions,
  actionsOpen = false,
  touchOptimizedActions = false,
  isDragging = false,
  isDropTarget = false,
  style,
  paneState,
}: TerminalSessionFrameProps) {
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const interactive = Boolean(onActivate);
  const draggableHeader = Boolean(dragHandleListeners);

  function handleFrameClick(event: MouseEvent<HTMLDivElement>) {
    if (!onActivate) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("[data-terminal-surface='true']")) return;
    onActivate();
  }

  function handleFrameFocus(event: FocusEvent<HTMLDivElement>) {
    if (!onFocusActivate || event.currentTarget !== event.target) return;
    onActivate?.();
  }

  function handleFrameKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!interactive || event.currentTarget !== event.target) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate?.();
  }

  function handleHeaderContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (!onOpenActions) return;
    const target = event.target;
    const interactiveTarget =
      target instanceof Element
        ? target.closest("button, a, input, select, textarea, [role='button'], [role='link']")
        : null;
    if (interactiveTarget && event.currentTarget.contains(interactiveTarget)) {
      return;
    }
    event.preventDefault();
    if (actionsButtonRef.current) onOpenActions(actionsButtonRef.current);
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
        className,
      )}
      data-active={active ? "true" : "false"}
      data-terminal-audio-frame="true"
      data-pane-label={label}
      data-pane-mode={layoutMode}
      data-pane-state={paneState}
      data-testid={dataTestId}
      style={style}
      tabIndex={interactive ? 0 : undefined}
      onClick={handleFrameClick}
      onFocus={handleFrameFocus}
      onKeyDown={handleFrameKeyDown}
      onMouseMove={onMouseMove}
    >
      {showHeader ? (
        <div
          className={cn(
            "flex min-h-10 shrink-0 select-none items-center gap-1 border-b border-white/10 bg-zinc-950 px-2 text-white",
            draggableHeader && "touch-none cursor-grab active:cursor-grabbing",
          )}
          data-window-drag-surface={draggableHeader ? "true" : undefined}
          data-launcher-gesture-ignore={draggableHeader ? "true" : undefined}
          data-testid={dataTestId ? `${dataTestId}-header` : undefined}
          onContextMenu={handleHeaderContextMenu}
        >
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch"
            title={
              draggableHeader
                ? "Drag to rearrange. Ctrl/Cmd+Alt+Shift+Arrow moves the focused pane."
                : undefined
            }
            {...dragHandleListeners}
          >
            {draggableHeader ? (
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
          <div data-terminal-audio-slot="true" className="flex shrink-0" />
          {touchOptimizedActions ? null : headerActions}
          {onOpenActions ? (
            <ShortcutTooltip
              label="More actions"
              shortcuts={PANE_CONTROL_SHORTCUTS.actions.keys}
              trigger={
                <Button
                  ref={actionsButtonRef}
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={cn(
                    TERMINAL_CONTROL_BUTTON_CLASS_NAME,
                    TERMINAL_CONTROL_HOVER_CLASS_NAME,
                    "text-foreground hover:text-foreground",
                    touchOptimizedActions && "size-11 min-h-11",
                  )}
                  aria-label={`Open actions for ${label}`}
                  data-terminal-control="actions"
                  aria-haspopup={touchOptimizedActions ? "dialog" : "menu"}
                  aria-expanded={actionsOpen}
                  data-testid={dataTestId ? `${dataTestId}-actions` : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenActions(event.currentTarget);
                  }}
                >
                  <Ellipsis className="size-4" />
                </Button>
              }
            />
          ) : null}
          {onClose ? (
            <ShortcutTooltip
              label={closeLabel ?? `Close ${label}`}
              shortcuts={PANE_CONTROL_SHORTCUTS.close.keys}
              trigger={
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  className={cn(
                    TERMINAL_CONTROL_BUTTON_CLASS_NAME,
                    TERMINAL_CLOSE_HOVER_CLASS_NAME,
                    touchOptimizedActions && "size-11 min-h-11",
                  )}
                  aria-label={closeLabel ?? `Close ${label}`}
                  data-terminal-control="close"
                  data-testid={closeTestId}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(event);
                  }}
                >
                  <X className="size-4" />
                </Button>
              }
            />
          ) : null}
        </div>
      ) : null}
      <div
        className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", contentClassName)}
        data-terminal-frame-content="true"
      >
        {children}
      </div>
    </div>
  );
}
