"use client";
import { Grid2X2, GripHorizontal, Minus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DockVerticalContext } from "./dock-axis";
import { useDockMorph } from "./use-dock-morph";
import { useDockPlacement } from "./use-dock-placement";
import "./workspace-dock-overlay.css";

export function WorkspaceDockOverlay({
  children,
  blocked = false,
}: {
  children: ReactNode;
  blocked?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null),
    layout = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const expand = useRef<HTMLButtonElement>(null),
    minimise = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false),
    [interacting, setInteracting] = useState(false),
    [touching, setTouching] = useState(false),
    [activity, setActivity] = useState(0);
  const morph = useDockMorph({ surface, layout, content, expand, minimise, blocked });
  const placement = useDockPlacement(surface, blocked || morph.busy);
  const vertical = placement.edge === "left" || placement.edge === "right";
  const id = useId();
  const latestActivity = useRef(0);
  useEffect(() => {
    if (morph.phase === "collapsed") {
      setHovered(false);
      setFocused(false);
    }
  }, [morph.phase]);
  useEffect(() => {
    if (
      morph.phase !== "expanded" ||
      hovered ||
      focused ||
      interacting ||
      touching ||
      blocked ||
      placement.moving
    )
      return;
    const timer = window.setTimeout(() => {
      if (activity === latestActivity.current && !content.current?.contains(document.activeElement))
        morph.change(false);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [
    morph.phase,
    hovered,
    focused,
    interacting,
    touching,
    activity,
    blocked,
    placement.moving,
    morph.change,
  ]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        blocked ||
        placement.dragging ||
        event.repeat ||
        event.isComposing ||
        !event.altKey ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.code !== "KeyD"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      placement.finishMovement();
      morph.change(!morph.expanded, true);
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  });
  return (
    <div
      ref={placement.root}
      className="hive-dock-overlay"
      data-launcher-gesture-ignore="true"
      data-dock-visible={morph.expanded}
      data-phase={morph.phase}
      data-edge={placement.edge}
      data-orientation={vertical ? "vertical" : "horizontal"}
      data-dragging={placement.dragging}
      data-settling={placement.settling}
      {...placement.handlers}
      onPointerDownCapture={() => {
        setActivity(++latestActivity.current);
        setInteracting(true);
      }}
      onTouchStartCapture={() => setTouching(true)}
      onTouchEndCapture={(event) => {
        if (!event.touches.length) setTouching(false);
      }}
      onTouchCancelCapture={() => setTouching(false)}
      onPointerUpCapture={() => setInteracting(false)}
      onPointerCancelCapture={() => setInteracting(false)}
      onLostPointerCaptureCapture={() => setInteracting(false)}
    >
      <div ref={surface} className="hive-dock-surface" aria-busy={morph.busy}>
        <div
          ref={layout}
          className="hive-dock-layout"
          inert={morph.phase !== "expanded"}
          aria-hidden={morph.phase !== "expanded"}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") setHovered(true);
          }}
          onPointerLeave={() => setHovered(false)}
          onFocusCapture={(event) =>
            setFocused(
              content.current?.contains(event.target) === true ||
                (event.target as Element).hasAttribute("data-dock-drag-handle"),
            )
          }
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
          }}
        >
          <div className="hive-dock-chrome">
            <Button
              ref={minimise}
              type="button"
              variant="ghost"
              className="hive-dock-minimise"
              data-dock-minimise
              aria-label="Minimise dock"
              aria-expanded={morph.expanded}
              aria-controls={id}
              aria-keyshortcuts="Alt+Shift+D"
              title="Minimise dock (Alt+Shift+D)"
              onClick={() => {
                placement.finishMovement();
                morph.change(false);
              }}
            >
              <Minus aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="hive-dock-grip"
              data-dock-drag-handle
              aria-label="Move dock"
              aria-describedby={`${id}-help`}
              title="Drag to an edge. Arrow keys move; Shift+Arrow chooses an edge."
              onKeyDown={placement.key}
            >
              <GripHorizontal aria-hidden="true" />
            </Button>
          </div>
          <div
            ref={content}
            id={id}
            className="hive-dock-overlay-content"
            inert={placement.settling}
          >
            <DockVerticalContext value={vertical}>{children}</DockVerticalContext>
          </div>
        </div>
        <Button
          ref={expand}
          type="button"
          variant="ghost"
          className="hive-dock-expand"
          data-dock-expand
          aria-label="Expand dock"
          aria-expanded={morph.expanded}
          aria-controls={id}
          aria-describedby={`${id}-help`}
          aria-keyshortcuts="Alt+Shift+D"
          aria-disabled={morph.busy}
          inert={morph.phase === "expanded"}
          aria-hidden={morph.phase === "expanded"}
          tabIndex={morph.phase === "expanded" ? -1 : 0}
          title="Expand dock. Drag to move (Alt+Shift+D)"
          onKeyDown={placement.key}
          onClick={() => {
            placement.finishMovement();
            morph.change(true);
          }}
        >
          <Grid2X2 aria-hidden="true" />
        </Button>
      </div>
      <span id={`${id}-help`} className="sr-only">
        Drag the Move button or expand button; release to attach to the nearest screen edge. Arrow
        keys move along an edge; Shift+Arrow chooses an edge. Home/End move to corners. Escape
        cancels a drag. Alt+Shift+D expands or minimises. The dock minimises after 2.5 seconds away.
      </span>
      <span className="sr-only" role="status">
        Dock attached to the {placement.edge} edge.
      </span>
    </div>
  );
}
