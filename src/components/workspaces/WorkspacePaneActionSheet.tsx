"use client";

import { useDrag } from "@use-gesture/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Code2,
  ExternalLink,
  Files,
  Focus,
  ScrollText,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  DRAG_DISMISS_DISTANCE_PX,
  DRAG_DISMISS_VELOCITY,
  NO_TOUCH_STYLE,
} from "@/lib/gestures/conventions";
import { cn } from "@/lib/utils";

export type WorkspacePaneActionIcon =
  | "activate"
  | "code"
  | "pop-out"
  | "files"
  | "logs"
  | "move-down"
  | "move-left"
  | "move-right"
  | "move-up"
  | "remove";

export interface WorkspacePaneAction {
  id: string;
  label: string;
  description?: string;
  icon: WorkspacePaneActionIcon;
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void;
}

interface WorkspacePaneActionSheetProps {
  actions: readonly WorkspacePaneAction[];
  description?: string;
  label: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const SNAP_BACK_TRANSITION = "transform 150ms ease-out";
const dragHandleStyle: CSSProperties = { ...NO_TOUCH_STYLE, touchAction: "none" };

function vectorValue(vector: unknown, index: number): number {
  if (!Array.isArray(vector)) return 0;
  const value = vector[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ActionIcon({ icon }: { icon: WorkspacePaneActionIcon }) {
  if (icon === "move-left") return <ArrowLeft data-icon="inline-start" />;
  if (icon === "move-right") return <ArrowRight data-icon="inline-start" />;
  if (icon === "move-up") return <ArrowUp data-icon="inline-start" />;
  if (icon === "move-down") return <ArrowDown data-icon="inline-start" />;
  if (icon === "files") return <Files data-icon="inline-start" />;
  if (icon === "code") return <Code2 data-icon="inline-start" />;
  if (icon === "logs") return <ScrollText data-icon="inline-start" />;
  if (icon === "pop-out") return <ExternalLink data-icon="inline-start" />;
  if (icon === "remove") return <X data-icon="inline-start" />;
  return <Focus data-icon="inline-start" />;
}

export function WorkspacePaneActionSheet({
  actions,
  description,
  label,
  onOpenChange,
  open,
}: WorkspacePaneActionSheetProps) {
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isSnapBack, setIsSnapBack] = useState(false);

  useEffect(() => {
    if (!open) {
      setDragY(0);
      setIsDragging(false);
      setIsSnapBack(false);
    }
  }, [open]);

  useEffect(() => {
    if (!isSnapBack) return;
    const timeoutId = window.setTimeout(() => setIsSnapBack(false), 150);
    return () => window.clearTimeout(timeoutId);
  }, [isSnapBack]);

  const bindDragHandle = useDrag(
    ({ active, direction, event, movement, velocity }) => {
      if (!isMobile) return;
      const movementY = Math.max(0, vectorValue(movement, 1));
      const directionY = vectorValue(direction, 1);
      const velocityY = directionY > 0 ? vectorValue(velocity, 1) : 0;

      if ((active || movementY > 0) && event?.cancelable) event.preventDefault();
      if (active) {
        setIsDragging(true);
        setIsSnapBack(false);
        setDragY(movementY);
        return;
      }

      setIsDragging(false);
      if (movementY >= DRAG_DISMISS_DISTANCE_PX || velocityY >= DRAG_DISMISS_VELOCITY) {
        setDragY(0);
        setIsSnapBack(false);
        onOpenChange(false);
        return;
      }
      setDragY(0);
      setIsSnapBack(!prefersReducedMotion);
    },
    { axis: "y", eventOptions: { passive: false }, filterTaps: true },
  );

  const sheetStyle = useMemo<CSSProperties>(() => {
    if (!isMobile || prefersReducedMotion) return {};
    if (isDragging) return { transform: `translateY(${dragY}px)`, transition: "none" };
    if (dragY > 0 || isSnapBack) {
      return { transform: `translateY(${dragY}px)`, transition: SNAP_BACK_TRANSITION };
    }
    return {};
  }, [dragY, isDragging, isMobile, isSnapBack, prefersReducedMotion]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-hidden overscroll-contain p-0 motion-reduce:transition-none motion-reduce:duration-0",
          isMobile && "max-h-[min(42rem,calc(100dvh-2rem))] rounded-t-2xl pb-safe",
        )}
        style={sheetStyle}
        data-testid="workspace-pane-action-sheet"
      >
        {isMobile ? (
          <button
            {...bindDragHandle()}
            type="button"
            aria-label="Drag to dismiss pane actions"
            className="flex h-11 w-full shrink-0 items-center justify-center border-0 bg-transparent p-0 text-inherit"
            style={dragHandleStyle}
            onClick={() => onOpenChange(false)}
          >
            <span className="h-1 w-10 rounded-full bg-muted-foreground/35" aria-hidden="true" />
          </button>
        ) : null}
        <SheetHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b">
          <div className="min-w-0">
            <SheetTitle className="truncate">{label}</SheetTitle>
            <SheetDescription>{description ?? "Pane actions"}</SheetDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Close pane actions"
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </SheetHeader>
        <fieldset
          className="grid min-h-0 grid-cols-2 gap-2 overflow-y-auto p-3"
          data-mobile-scroll-allow="true"
        >
          <legend className="sr-only">{`Actions for ${label}`}</legend>
          {actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              variant={action.destructive ? "destructive" : "outline"}
              className={cn(
                "min-h-14 min-w-0 justify-start px-3 py-2 text-left",
                action.destructive && "col-span-2",
              )}
              disabled={action.disabled}
              data-testid={`workspace-pane-action-${action.id}`}
              onClick={() => {
                action.onSelect();
                onOpenChange(false);
              }}
            >
              <ActionIcon icon={action.icon} />
              <span className="min-w-0">
                <span className="block truncate">{action.label}</span>
                {action.description ? (
                  <span className="block truncate text-xs font-normal opacity-70">
                    {action.description}
                  </span>
                ) : null}
              </span>
            </Button>
          ))}
        </fieldset>
      </SheetContent>
    </Sheet>
  );
}
