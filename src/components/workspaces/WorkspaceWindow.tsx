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
}

interface WorkspaceWindowProps {
  children: (state: WorkspaceWindowRenderState) => ReactNode;
  id: string;
  previewStyle?: CSSProperties;
  style: CSSProperties;
}

export function WorkspaceWindow({ children, id, previewStyle, style }: WorkspaceWindowProps) {
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
        "absolute min-h-0 min-w-0 overflow-hidden p-0.5 transition-[left,top,width,height,opacity] duration-150 ease-out motion-reduce:transition-none",
        isDragging && "pointer-events-none opacity-0",
      )}
      data-workspace-window-id={id}
      data-workspace-window-dragging={isDragging ? "true" : "false"}
      data-workspace-window-previewing={previewStyle && !isDragging ? "true" : "false"}
      style={{
        ...(isDragging ? style : (previewStyle ?? style)),
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        zIndex: isDragging ? 20 : undefined,
      }}
    >
      {children({
        dragHandleAttributes: attributes,
        dragHandleListeners: listeners,
        isDragging,
      })}
    </div>
  );
}

interface WorkspaceWindowDropPlaceholderProps {
  position?: WorkspaceWindowDropPosition;
  style: CSSProperties;
}

export function WorkspaceWindowDropPlaceholder({
  position,
  style,
}: WorkspaceWindowDropPlaceholderProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 min-h-0 min-w-0 p-0.5 transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none"
      data-workspace-window-drop-placeholder="true"
      data-workspace-window-drop-position={position}
      data-testid="workspace-window-drop-placeholder"
      style={style}
    >
      <div className="h-full w-full rounded-md border-2 border-primary/80 bg-primary/10 shadow-[0_0_24px_rgb(141_255_157/0.18)]" />
    </div>
  );
}
