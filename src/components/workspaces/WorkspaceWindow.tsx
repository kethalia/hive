"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { type CSSProperties, type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { WorkspaceWindowDropPosition } from "@/lib/workspaces/workspace-window-layout";

interface WorkspaceWindowRenderState {
  dragHandleAttributes: ReturnType<typeof useDraggable>["attributes"];
  dragHandleListeners: ReturnType<typeof useDraggable>["listeners"];
  isDragging: boolean;
  isDropTarget: boolean;
}

interface WorkspaceWindowProps {
  children: (state: WorkspaceWindowRenderState) => ReactNode;
  dropPosition?: WorkspaceWindowDropPosition;
  id: string;
  style: CSSProperties;
}

export function WorkspaceWindow({ children, dropPosition, id, style }: WorkspaceWindowProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({ id, disabled: isDragging });
  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDraggableNodeRef(node);
      setDroppableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute min-h-0 min-w-0 overflow-hidden p-0.5 transition-opacity duration-150",
        isDragging && "pointer-events-none opacity-70",
      )}
      data-workspace-window-id={id}
      data-workspace-window-dragging={isDragging ? "true" : "false"}
      data-workspace-window-drop-position={dropPosition}
      data-workspace-window-drop-target={dropPosition && !isDragging ? "true" : "false"}
      style={{
        ...style,
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        zIndex: isDragging ? 20 : undefined,
      }}
    >
      {children({
        dragHandleAttributes: attributes,
        dragHandleListeners: listeners,
        isDragging,
        isDropTarget: Boolean(dropPosition) && !isDragging,
      })}
      {dropPosition && !isDragging ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute z-30 rounded-md bg-primary/20 ring-2 ring-inset ring-primary/80 shadow-[0_0_24px_rgb(141_255_157/0.18)]",
            dropPosition === "top" && "inset-x-1 top-1 bottom-1/2",
            dropPosition === "bottom" && "inset-x-1 top-1/2 bottom-1",
            dropPosition === "left" && "inset-y-1 left-1 right-1/2",
            dropPosition === "right" && "inset-y-1 right-1 left-1/2",
          )}
          data-workspace-window-drop-preview="true"
        />
      ) : null}
    </div>
  );
}
