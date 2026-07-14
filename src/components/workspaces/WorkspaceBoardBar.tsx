"use client";

import { X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkspaceBoard } from "@/lib/workspaces/workspace-board-state";

export interface WorkspaceBoardBarProps {
  boards: readonly WorkspaceBoard[];
  activeBoardKey?: string;
  onCreate?: () => void;
  onDelete?: (boardKey: string) => void;
  onSelect?: (boardKey: string) => void;
  className?: string;
}

export function WorkspaceBoardBar({
  boards,
  activeBoardKey,
  onCreate,
  onDelete,
  onSelect,
  className,
}: WorkspaceBoardBarProps) {
  const [dangerBoardKey, setDangerBoardKey] = useState<string | null>(null);
  const orderedBoards = useMemo(() => orderedWorkspaceBoards(boards), [boards]);
  const activeKey = orderedBoards.some((board) => board.key === activeBoardKey)
    ? activeBoardKey
    : orderedBoards[0]?.key;
  const canDelete = orderedBoards.length > 1;

  useEffect(() => {
    if (
      dangerBoardKey &&
      (!canDelete || !orderedBoards.some((board) => board.key === dangerBoardKey))
    ) {
      setDangerBoardKey(null);
    }
  }, [canDelete, dangerBoardKey, orderedBoards]);

  function selectBoard(boardKey: string) {
    if (boardKey === activeKey) return;
    onSelect?.(boardKey);
  }

  function handleBoardPress(boardKey: string) {
    if (canDelete && boardKey === activeKey && dangerBoardKey === boardKey) {
      onDelete?.(boardKey);
      setDangerBoardKey(null);
      return;
    }
    if (canDelete && boardKey !== activeKey) {
      setDangerBoardKey(boardKey);
    }
    selectBoard(boardKey);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, boardKey: string) {
    const currentIndex = orderedBoards.findIndex((board) => board.key === boardKey);
    if (currentIndex < 0) return;

    const lastIndex = orderedBoards.length - 1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
    if (event.key === "ArrowLeft") nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = lastIndex;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextBoard = orderedBoards[nextIndex];
    if (nextBoard) {
      selectBoard(nextBoard.key);
      event.currentTarget
        .closest('[role="tablist"]')
        ?.querySelector<HTMLButtonElement>(`[data-testid="workspace-board-tab-${nextBoard.key}"]`)
        ?.focus();
    }
  }

  return (
    <section
      className={cn("flex min-w-0 items-center gap-1", className)}
      aria-label="Workspaces"
      data-testid="workspace-board-bar"
    >
      <div
        role="tablist"
        aria-label="Workspaces"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        data-mobile-scroll-allow="true"
        data-testid="workspace-board-tablist"
      >
        {orderedBoards.map((board, index) => {
          const number = index + 1;
          const isActive = board.key === activeKey;
          const isDanger = canDelete && isActive && dangerBoardKey === board.key;

          return (
            <Button
              key={board.key}
              type="button"
              role="tab"
              variant={isDanger ? "destructive" : isActive ? "secondary" : "ghost"}
              size="xs"
              aria-label={isDanger ? `Delete workspace ${number}` : `Open workspace ${number}`}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-active={isActive ? "true" : "false"}
              data-testid={`workspace-board-tab-${board.key}`}
              className="h-7 min-h-0 w-7 shrink-0 px-0 font-mono text-xs tabular-nums"
              onClick={() => handleBoardPress(board.key)}
              onKeyDown={(event) => handleTabKeyDown(event, board.key)}
              onMouseEnter={() => {
                if (canDelete && isActive) setDangerBoardKey(board.key);
              }}
              onMouseLeave={() => {
                if (dangerBoardKey === board.key) setDangerBoardKey(null);
              }}
              onBlur={() => {
                if (dangerBoardKey === board.key) setDangerBoardKey(null);
              }}
            >
              {isDanger ? <X className="size-3.5" data-testid="workspace-board-delete" /> : number}
            </Button>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onCreate}
        className="h-7 min-h-0 w-7 shrink-0 px-0 font-mono text-xs"
        aria-label="Create workspace"
        data-testid="workspace-board-new"
      >
        +
      </Button>
    </section>
  );
}

function orderedWorkspaceBoards(boards: readonly WorkspaceBoard[]): WorkspaceBoard[] {
  return [...boards].sort((left, right) => {
    const leftOrder = finiteNumberOrFallback(left.order, 0);
    const rightOrder = finiteNumberOrFallback(right.order, 0);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.key.localeCompare(right.key);
  });
}

function finiteNumberOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
