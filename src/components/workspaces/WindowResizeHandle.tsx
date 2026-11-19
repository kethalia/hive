"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Pointer capture keeps resizing alive over terminals and cross-origin app frames. */
export function WindowResizeHandle({
  label,
  axis,
  value,
  min,
  max,
  extent,
  style,
  gripOffsetX,
  onChange,
  onInteraction,
}: {
  label: string;
  axis: "width" | "height";
  value: number;
  min: number;
  max: number;
  extent: number;
  style: CSSProperties;
  gripOffsetX?: number;
  onChange: (value: number) => void;
  onInteraction: (active: boolean) => void;
}) {
  const drag = useRef<{ point: number; value: number; pending?: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);
  const change = useRef(onChange);
  change.current = onChange;
  const interaction = useRef(onInteraction);
  interaction.current = onInteraction;
  const stripGrip = gripOffsetX !== undefined;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      if (drag.current) interaction.current(false);
    },
    [],
  );
  const finish = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (drag.current?.pending !== undefined) change.current(drag.current.pending);
    drag.current = null;
    setDragging(false);
    onInteraction(false);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: Focusable adjustable separator implements the window splitter pattern.
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "width" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      className={cn(
        "group/resize-handle absolute z-30 touch-none overflow-hidden outline-none",
        axis === "width" ? "cursor-col-resize" : "cursor-row-resize",
      )}
      style={style}
      data-window-resize=""
      data-launcher-gesture-ignore="true"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        // Keep the native keyboard stable while a finger adjusts the window.
        if (event.pointerType !== "touch") event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { point: axis === "width" ? event.clientX : event.clientY, value };
        setDragging(true);
        onInteraction(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.pending = clamp(
          drag.current.value +
            ((axis === "width" ? event.clientX : event.clientY) - drag.current.point) / extent,
        );
        if (!frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (drag.current?.pending !== undefined) change.current(drag.current.pending);
          });
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => onChange(clamp(0.5))}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        onChange(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : clamp(value + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.05 : 0.05)),
        );
      }}
    >
      <span
        aria-hidden="true"
        style={stripGrip ? { left: gripOffsetX } : undefined}
        className={cn(
          "pointer-events-none absolute top-1/2 left-1/2 max-h-full max-w-full -translate-x-1/2 -translate-y-1/2 rounded-full",
          axis === "width" ? "h-8 w-0.5" : "h-0.5 w-8",
          stripGrip && !dragging
            ? "bg-muted-foreground group-focus-visible/resize-handle:bg-primary"
            : "bg-primary",
          dragging ? "opacity-100" : "opacity-0 group-focus-visible/resize-handle:opacity-100",
          !dragging && "group-hover/resize-handle:opacity-60",
        )}
      />
    </div>
  );
}
