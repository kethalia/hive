"use client";

import { useDrag } from "@use-gesture/react";
import { Plus, Search, Terminal } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import {
  DRAG_DISMISS_DISTANCE_PX,
  DRAG_DISMISS_VELOCITY,
  NO_TOUCH_STYLE,
} from "@/lib/gestures/conventions";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";

const CREATE_SESSION_SHORTCUT_KEYS = ["ctrl+shift+n", "cmd+shift+n"] as const;

export interface CommandPaletteAction {
  id: string;
  label: string;
  description?: string;
  group: string;
  value?: string;
  shortcut?: string;
  rightLabel?: string;
  disabled?: boolean;
  icon?: "plus" | "search" | "terminal";
  onSelect: () => void;
  options?: CommandPaletteActionOption[];
}

export interface CommandPaletteActionOption {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Array<{ id: string; sessionName: string }>;
  onSelectTab: (tabId: string) => void;
  onCreateSession?: () => void;
  actions?: CommandPaletteAction[];
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  groupHeading?: string;
}

const mobileCommandClassName =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-group]]:px-2";

const SNAP_BACK_TRANSITION = "transform 150ms ease-out";

const dragHandleStyle: CSSProperties = {
  ...NO_TOUCH_STYLE,
  touchAction: "none",
};

interface CommandPaletteBodyProps {
  tabs: CommandPaletteProps["tabs"];
  onSelectTab: (tabId: string) => void;
  onOpenChange: (open: boolean) => void;
  onCreateSession?: () => void;
  actions: CommandPaletteAction[];
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
  searchPlaceholder: string;
  emptyText: string;
  groupHeading: string;
}

function getVectorValue(vector: unknown, index: number): number {
  if (!Array.isArray(vector)) return 0;
  const value = vector[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function actionIcon(icon: CommandPaletteAction["icon"]) {
  if (icon === "search") return <Search className="mr-2 size-4 shrink-0 opacity-70" />;
  if (icon === "plus") return <Plus className="mr-2 size-4 shrink-0 opacity-70" />;
  return <Terminal className="mr-2 size-4 shrink-0 opacity-70" />;
}

function selectedOptionIndex(
  action: CommandPaletteAction,
  selectedOptionIndexes: ReadonlyMap<string, number>,
): number {
  const storedIndex = selectedOptionIndexes.get(action.id);
  if (storedIndex !== undefined && !action.options?.at(storedIndex)?.disabled) return storedIndex;
  const firstEnabledIndex = action.options?.findIndex((option) => !option.disabled) ?? -1;
  return firstEnabledIndex >= 0 ? firstEnabledIndex : 0;
}

function CommandPaletteBody({
  tabs,
  onSelectTab,
  onOpenChange,
  onCreateSession,
  actions,
  searchValue,
  onSearchValueChange,
  searchPlaceholder,
  emptyText,
  groupHeading,
}: CommandPaletteBodyProps) {
  const handleSelect = useCallback(
    (tabId: string) => {
      onSelectTab(tabId);
      onOpenChange(false);
    },
    [onSelectTab, onOpenChange],
  );

  const handleCreate = useCallback(() => {
    onCreateSession?.();
    onOpenChange(false);
  }, [onCreateSession, onOpenChange]);
  const [selectedOptionIndexes, setSelectedOptionIndexes] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const actionGroups = useMemo(() => {
    const groups = new Map<string, CommandPaletteAction[]>();
    for (const action of actions) {
      const group = groups.get(action.group) ?? [];
      group.push(action);
      groups.set(action.group, group);
    }
    return [...groups.entries()];
  }, [actions]);

  const selectAction = useCallback(
    (action: CommandPaletteAction) => {
      const optionIndex = selectedOptionIndex(action, selectedOptionIndexes);
      const option = action.options?.at(optionIndex);
      if (option) {
        if (option.disabled) return;
        option.onSelect();
      } else {
        action.onSelect();
      }
      onOpenChange(false);
    },
    [onOpenChange, selectedOptionIndexes],
  );

  const handleActionArrowKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const selectedItem = event.currentTarget.querySelector<HTMLElement>(
        '[cmdk-item][aria-selected="true"][data-action-id]',
      );
      const actionId = selectedItem?.dataset.actionId;
      const action = actionId ? actions.find((candidate) => candidate.id === actionId) : undefined;
      const options = action?.options;
      if (!action || !options || options.length < 2) return;

      event.preventDefault();
      event.stopPropagation();
      setSelectedOptionIndexes((current) => {
        const currentIndex = selectedOptionIndex(action, current);
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const enabledIndexes = options.flatMap((option, index) => (option.disabled ? [] : [index]));
        if (enabledIndexes.length === 0) return current;
        const currentPosition = enabledIndexes.indexOf(currentIndex);
        const nextPosition =
          (currentPosition + delta + enabledIndexes.length) % enabledIndexes.length;
        const nextIndex = enabledIndexes.at(nextPosition) ?? currentIndex;
        return new Map(current).set(action.id, nextIndex);
      });
    },
    [actions],
  );

  return (
    <div onKeyDownCapture={handleActionArrowKey}>
      <CommandInput
        placeholder={searchPlaceholder}
        value={searchValue}
        onValueChange={onSearchValueChange}
      />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        {actionGroups.map(([heading, groupActions]) => (
          <CommandGroup key={heading} heading={heading}>
            {groupActions.map((action) => (
              <CommandItem
                key={action.id}
                data-action-id={action.id}
                value={action.value ?? `${action.label} ${action.description ?? ""}`}
                onSelect={() => {
                  if (action.disabled) return;
                  selectAction(action);
                }}
                disabled={action.disabled}
              >
                {actionIcon(action.icon)}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{action.label}</span>
                  {action.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {action.description}
                    </span>
                  ) : null}
                </span>
                {action.shortcut ? <CommandShortcut>{action.shortcut}</CommandShortcut> : null}
                {action.options ? (
                  <span
                    className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background/70 p-0.5"
                    title="Choose action with Left and Right arrow keys"
                  >
                    {action.options.map((option, index) => (
                      <button
                        key={option.id}
                        type="button"
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
                          index === selectedOptionIndex(action, selectedOptionIndexes) &&
                            "bg-primary text-primary-foreground",
                          option.disabled && "opacity-40",
                        )}
                        data-testid={`command-option-${action.id}-${option.id}`}
                        data-selected={
                          index === selectedOptionIndex(action, selectedOptionIndexes)
                            ? "true"
                            : "false"
                        }
                        disabled={option.disabled}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (option.disabled) return;
                          option.onSelect();
                          onOpenChange(false);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </span>
                ) : action.rightLabel ? (
                  <span className="ml-auto text-xs text-muted-foreground">{action.rightLabel}</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {tabs.length > 0 ? (
          <CommandGroup heading={groupHeading}>
            {tabs.map((tab) => (
              <CommandItem
                key={tab.id}
                value={tab.sessionName}
                onSelect={() => {
                  handleSelect(tab.id);
                }}
              >
                <Terminal className="mr-2 size-4 shrink-0 opacity-70" />
                <span className="font-mono text-sm">{tab.sessionName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {onCreateSession && (
          <CommandGroup heading="Actions">
            <CommandItem onSelect={handleCreate}>
              <Plus className="mr-2 size-4 shrink-0 opacity-70" />
              <span>New Session</span>
              <CommandShortcut>{formatShortcut(CREATE_SESSION_SHORTCUT_KEYS)}</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </div>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  tabs,
  onSelectTab,
  onCreateSession,
  actions = [],
  searchValue,
  onSearchValueChange,
  searchPlaceholder = "Search sessions…",
  emptyText = "No sessions found.",
  groupHeading = "Sessions",
}: CommandPaletteProps) {
  const isMobile = useIsMobile();
  const { height } = useVisualViewportHeight();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isSnapBack, setIsSnapBack] = useState(false);
  const sheetMaxHeight = height !== null ? `${height}px` : "100dvh";

  useEffect(() => {
    if (!open) {
      setDragY(0);
      setIsDragging(false);
      setIsSnapBack(false);
    }
  }, [open]);

  useEffect(() => {
    if (!isSnapBack) return;

    const timeoutId = window.setTimeout(() => {
      setIsSnapBack(false);
    }, 150);

    return () => window.clearTimeout(timeoutId);
  }, [isSnapBack]);

  const bindDragHandle = useDrag(
    ({ active, direction, event, movement, velocity }) => {
      const movementY = Math.max(0, getVectorValue(movement, 1));
      const directionY = getVectorValue(direction, 1);
      const velocityY = directionY > 0 ? getVectorValue(velocity, 1) : 0;
      const isDownwardDrag = Boolean(active) || movementY > 0;

      if (isDownwardDrag && event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }

      if (active) {
        setIsDragging(true);
        setIsSnapBack(false);
        setDragY(movementY);
        return;
      }

      setIsDragging(false);

      const shouldDismiss =
        movementY >= DRAG_DISMISS_DISTANCE_PX || velocityY >= DRAG_DISMISS_VELOCITY;

      if (shouldDismiss) {
        setDragY(0);
        setIsSnapBack(false);
        onOpenChange(false);
        return;
      }

      setDragY(0);
      setIsSnapBack(!prefersReducedMotion);
    },
    {
      axis: "y",
      eventOptions: { passive: false },
      filterTaps: true,
    },
  );

  const sheetStyle = useMemo<CSSProperties>(() => {
    const style: CSSProperties = { maxHeight: sheetMaxHeight };

    if (!prefersReducedMotion) {
      if (dragY > 0 || isSnapBack) {
        style.transform = `translateY(${dragY}px)`;
      }

      if (isDragging) {
        style.transition = "none";
      } else if (isSnapBack) {
        style.transition = SNAP_BACK_TRANSITION;
      }
    }

    return style;
  }, [dragY, isDragging, isSnapBack, prefersReducedMotion, sheetMaxHeight]);

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="gap-0 overflow-hidden overscroll-contain rounded-t-2xl p-0 pb-safe motion-reduce:transition-none motion-reduce:duration-0"
          style={sheetStyle}
        >
          <SheetTitle className="sr-only">Command palette</SheetTitle>
          <button
            {...bindDragHandle()}
            type="button"
            aria-label="Drag to dismiss command palette"
            className="flex h-11 w-full shrink-0 items-center justify-center border-0 bg-transparent p-0 text-inherit"
            style={dragHandleStyle}
            onClick={() => onOpenChange(false)}
          >
            <span className="h-1 w-10 rounded-full bg-muted-foreground/35" aria-hidden="true" />
          </button>
          <Command className={mobileCommandClassName}>
            <CommandPaletteBody
              tabs={tabs}
              onSelectTab={onSelectTab}
              onOpenChange={onOpenChange}
              onCreateSession={onCreateSession}
              actions={actions}
              searchValue={searchValue}
              onSearchValueChange={onSearchValueChange}
              searchPlaceholder={searchPlaceholder}
              emptyText={emptyText}
              groupHeading={groupHeading}
            />
          </Command>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandPaletteBody
        tabs={tabs}
        onSelectTab={onSelectTab}
        onOpenChange={onOpenChange}
        onCreateSession={onCreateSession}
        actions={actions}
        searchValue={searchValue}
        onSearchValueChange={onSearchValueChange}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        groupHeading={groupHeading}
      />
    </CommandDialog>
  );
}
