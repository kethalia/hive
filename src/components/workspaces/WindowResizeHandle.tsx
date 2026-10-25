"use client";

import { type CSSProperties, useEffect, useRef } from "react";

/** Pointer capture keeps resizing alive over terminals and cross-origin app frames. */
export function WindowResizeHandle({
  label,
  axis,
  value,
  min,
  max,
  extent,
  style,
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
  onChange: (value: number) => void;
  onInteraction: (active: boolean) => void;
}) {
  const drag = useRef<{ point: number; value: number; pending?: number } | null>(null);
  const frame = useRef(0);
  const change = useRef(onChange);
  change.current = onChange;
  const interaction = useRef(onInteraction);
  interaction.current = onInteraction;
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
      className={`group/resize absolute z-30 flex touch-none items-center justify-center focus-visible:outline-none ${axis === "width" ? "cursor-col-resize" : "cursor-row-resize"}`}
      style={style}
      data-window-resize=""
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { point: axis === "width" ? event.clientX : event.clientY, value };
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
      {/* Keep the full edge draggable; only the small grip carries interaction feedback. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none shrink-0 rounded-full bg-muted-foreground/30 transition-colors group-hover/resize:bg-muted-foreground/70 group-focus-visible/resize:bg-primary/80 group-focus-visible/resize:outline-2 group-focus-visible/resize:outline-offset-2 group-focus-visible/resize:outline-primary/70 group-active/resize:bg-primary/80 motion-reduce:transition-none ${axis === "width" ? "h-8 w-0.5" : "h-0.5 w-8"}`}
      />
    </div>
  );
}
