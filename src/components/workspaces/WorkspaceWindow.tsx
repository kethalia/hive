"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { type CSSProperties, type PointerEventHandler, type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { WorkspaceWindowDropPosition } from "@/lib/workspaces/workspace-window-layout";

interface WorkspaceWindowRenderState {
  isDragging: boolean;
  onHeaderPointerDown: PointerEventHandler<HTMLDivElement>;
}

interface WorkspaceWindowProps {
  children: (state: WorkspaceWindowRenderState) => ReactNode;
  disabled?: boolean;
  id: string;
  previewStyle?: CSSProperties;
  style: CSSProperties;
}

export function WorkspaceWindow({
  children,
  disabled = false,
  id,
  previewStyle,
  style,
}: WorkspaceWindowProps) {
  const {
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id, disabled });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id,
    disabled: disabled || isDragging,
  });
  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDraggableNodeRef(node);
      setDroppableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );
  const onHeaderPointerDown = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      listeners?.onPointerDown?.(event);
    },
    [listeners],
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute min-h-0 min-w-0 overflow-hidden p-0.5 transition-[left,top,width,height,opacity] duration-150 ease-out motion-reduce:transition-none",
        isDragging && "pointer-events-none opacity-60",
      )}
      data-workspace-window-disabled={disabled ? "true" : "false"}
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
        isDragging,
        onHeaderPointerDown,
      })}
    </div>
  );
}

interface WorkspaceWindowDropPlaceholderProps {
  kind: "destination" | "origin";
  position?: WorkspaceWindowDropPosition;
  style: CSSProperties;
}

export function WorkspaceWindowDropPlaceholder({
  kind,
  position,
  style,
}: WorkspaceWindowDropPlaceholderProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 min-h-0 min-w-0 p-0.5 transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none"
      data-workspace-window-drop-kind={kind}
      data-workspace-window-drop-placeholder="true"
      data-workspace-window-drop-position={position}
      data-testid="workspace-window-drop-placeholder"
      style={style}
    >
      <div className="h-full w-full rounded-md border-2 border-primary/80 bg-primary/10 shadow-[0_0_24px_rgb(141_255_157/0.18)]" />
    </div>
  );
}
