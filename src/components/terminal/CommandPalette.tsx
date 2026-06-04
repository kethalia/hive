"use client";

import { useDrag } from "@use-gesture/react";
import { Plus, Terminal } from "lucide-react";
import type { CSSProperties } from "react";
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

const CREATE_SESSION_SHORTCUT_KEYS = ["ctrl+shift+n", "cmd+shift+n"] as const;

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Array<{ id: string; sessionName: string }>;
  onSelectTab: (tabId: string) => void;
  onCreateSession?: () => void;
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
  searchPlaceholder: string;
  emptyText: string;
  groupHeading: string;
}

function getVectorValue(vector: unknown, index: number): number {
  if (!Array.isArray(vector)) return 0;
  const value = vector[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function CommandPaletteBody({
  tabs,
  onSelectTab,
  onOpenChange,
  onCreateSession,
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

  return (
    <>
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        <CommandGroup heading={groupHeading}>
          {tabs.map((tab) => (
            <CommandItem key={tab.id} value={tab.sessionName} onSelect={() => handleSelect(tab.id)}>
              <Terminal className="mr-2 size-4 shrink-0 opacity-70" />
              <span className="font-mono text-sm">{tab.sessionName}</span>
            </CommandItem>
          ))}
        </CommandGroup>
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
    </>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  tabs,
  onSelectTab,
  onCreateSession,
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
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        groupHeading={groupHeading}
      />
    </CommandDialog>
  );
}
