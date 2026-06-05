"use client";

import type { FormEvent, KeyboardEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WorkspaceBoard } from "@/lib/workspaces/workspace-board-state";

export interface WorkspaceBoardBarProps {
  boards: readonly WorkspaceBoard[];
  activeBoardKey?: string;
  onCreate?: (name: string) => void;
  onRename?: (boardKey: string, name: string) => void;
  onDelete?: (boardKey: string) => void;
  onSelect?: (boardKey: string) => void;
  className?: string;
}

export function WorkspaceBoardBar({
  boards,
  activeBoardKey,
  onCreate,
  onRename,
  onDelete,
  onSelect,
  className,
}: WorkspaceBoardBarProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const orderedBoards = orderedWorkspaceBoards(boards);
  const activeKey = orderedBoards.some((board) => board.key === activeBoardKey)
    ? activeBoardKey
    : orderedBoards[0]?.key;
  const activeBoard = orderedBoards.find((board) => board.key === activeKey);
  const canDelete = orderedBoards.length > 1 && Boolean(activeBoard);

  function selectBoard(boardKey: string) {
    if (boardKey === activeKey) return;
    onSelect?.(boardKey);
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
    if (nextBoard) selectBoard(nextBoard.key);
  }

  function openCreateDialog() {
    setRenameDialogOpen(false);
    setCreateName("");
    setCreateError(null);
    setCreateDialogOpen(true);
  }

  function closeCreateDialog() {
    setCreateDialogOpen(false);
    setCreateError(null);
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    if (!name) {
      setCreateError("Enter a board name.");
      return;
    }
    onCreate?.(name);
    closeCreateDialog();
  }

  function openRenameDialog() {
    if (!activeBoard) return;
    setCreateDialogOpen(false);
    setRenameName(activeBoard.name);
    setRenameError(null);
    setRenameDialogOpen(true);
  }

  function closeRenameDialog() {
    setRenameDialogOpen(false);
    setRenameError(null);
  }

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = renameName.trim();
    if (!name) {
      setRenameError("Enter a board name.");
      return;
    }
    if (activeBoard) onRename?.(activeBoard.key, name);
    closeRenameDialog();
  }

  function deleteActiveBoard() {
    if (!canDelete || !activeBoard) return;
    onDelete?.(activeBoard.key);
  }

  return (
    <section
      className={cn("flex flex-wrap items-center gap-2", className)}
      aria-label="Workspace boards"
      data-testid="workspace-board-bar"
    >
      <div
        role="tablist"
        aria-label="Workspace boards"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        data-testid="workspace-board-tablist"
      >
        {orderedBoards.map((board) => {
          const isActive = board.key === activeKey;
          return (
            <Button
              key={board.key}
              type="button"
              role="tab"
              variant={isActive ? "secondary" : "ghost"}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-active={isActive ? "true" : "false"}
              data-testid={`workspace-board-tab-${board.key}`}
              onClick={() => selectBoard(board.key)}
              onKeyDown={(event) => handleTabKeyDown(event, board.key)}
            >
              {board.name}
            </Button>
          );
        })}
      </div>

      <fieldset className="flex shrink-0 items-center gap-1">
        <legend className="sr-only">Board actions</legend>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openCreateDialog}
          data-testid="workspace-board-new"
        >
          New
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openRenameDialog}
          disabled={!activeBoard}
          data-testid="workspace-board-rename"
        >
          Rename
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={deleteActiveBoard}
          disabled={!canDelete}
          data-testid="workspace-board-delete"
        >
          Delete
        </Button>
      </fieldset>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        {createDialogOpen && (
          <DialogContent data-testid="workspace-board-create-dialog">
            <DialogHeader>
              <DialogTitle>Create board</DialogTitle>
              <DialogDescription>Add a local board to this workspace.</DialogDescription>
            </DialogHeader>
            <form className="grid gap-3" onSubmit={submitCreate}>
              <label
                className="grid gap-1 text-sm font-medium"
                htmlFor="workspace-board-create-name"
              >
                Board name
                <Input
                  id="workspace-board-create-name"
                  value={createName}
                  onChange={(event) => {
                    setCreateName(event.target.value);
                    setCreateError(null);
                  }}
                  data-testid="workspace-board-create-input"
                  aria-invalid={createError ? true : undefined}
                  aria-describedby={createError ? "workspace-board-create-error" : undefined}
                />
              </label>
              {createError && (
                <p
                  id="workspace-board-create-error"
                  className="text-sm text-destructive"
                  data-testid="workspace-board-dialog-error"
                >
                  {createError}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={closeCreateDialog}>
                  Cancel
                </Button>
                <Button type="submit">Create board</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        {renameDialogOpen && (
          <DialogContent data-testid="workspace-board-rename-dialog">
            <DialogHeader>
              <DialogTitle>Rename board</DialogTitle>
              <DialogDescription>
                Update the active board name while keeping its key stable.
              </DialogDescription>
            </DialogHeader>
            <form className="grid gap-3" onSubmit={submitRename}>
              <label
                className="grid gap-1 text-sm font-medium"
                htmlFor="workspace-board-rename-name"
              >
                Board name
                <Input
                  id="workspace-board-rename-name"
                  value={renameName}
                  onChange={(event) => {
                    setRenameName(event.target.value);
                    setRenameError(null);
                  }}
                  data-testid="workspace-board-rename-input"
                  aria-invalid={renameError ? true : undefined}
                  aria-describedby={renameError ? "workspace-board-rename-error" : undefined}
                />
              </label>
              {renameError && (
                <p
                  id="workspace-board-rename-error"
                  className="text-sm text-destructive"
                  data-testid="workspace-board-dialog-error"
                >
                  {renameError}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={closeRenameDialog}>
                  Cancel
                </Button>
                <Button type="submit">Save board name</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
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
