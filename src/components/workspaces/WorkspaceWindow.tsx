"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { type CSSProperties, type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";

interface WorkspaceWindowRenderState {
  dragHandleAttributes: ReturnType<typeof useDraggable>["attributes"];
  dragHandleListeners: ReturnType<typeof useDraggable>["listeners"];
  isDragging: boolean;
  isDropTarget: boolean;
}

interface WorkspaceWindowProps {
  children: (state: WorkspaceWindowRenderState) => ReactNode;
  id: string;
  style: CSSProperties;
}

export function WorkspaceWindow({ children, id, style }: WorkspaceWindowProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id });
  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({ id });
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
        "absolute min-h-0 min-w-0 overflow-hidden transition-opacity duration-150",
        isDragging && "opacity-75",
      )}
      data-workspace-window-id={id}
      data-workspace-window-dragging={isDragging ? "true" : "false"}
      data-workspace-window-drop-target={isOver && !isDragging ? "true" : "false"}
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
        isDropTarget: isOver && !isDragging,
      })}
    </div>
  );
}
