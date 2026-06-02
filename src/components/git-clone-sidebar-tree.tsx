"use client";

import { type MouseEvent, useState } from "react";
import { ChevronRight, Folder, GitBranch, Star } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { PublicCloneTree } from "@/lib/git/clone-actions-contract";
import type { CloneTreeNode, CloneTreeRepositoryNode } from "@/lib/git/clone-tree";
import { cn } from "@/lib/utils";

export interface GitCloneSidebarTreeProps {
  tree: PublicCloneTree;
  favoriteKeys?: ReadonlySet<string>;
  onFavoriteToggle?: (repository: CloneTreeRepositoryNode, nextFavorited: boolean) => void;
  onRepositorySelect?: (repository: CloneTreeRepositoryNode) => void;
  className?: string;
}

export function GitCloneSidebarTree({
  tree,
  favoriteKeys,
  onFavoriteToggle,
  onRepositorySelect,
  className,
}: GitCloneSidebarTreeProps) {
  const [openDirectoryIds, setOpenDirectoryIds] = useState<ReadonlySet<string>>(() => new Set());

  const setDirectoryOpen = (nodeId: string, open: boolean) => {
    setOpenDirectoryIds((currentIds) => {
      const nextIds = new Set(currentIds);

      if (open) {
        nextIds.add(nodeId);
      } else {
        nextIds.delete(nodeId);
      }

      return nextIds;
    });
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} data-testid="git-clone-tree">
      <SidebarMenu>
        <Collapsible defaultOpen className="group/git-projects">
          <SidebarMenuItem>
            <SidebarMenuSubButton
              render={<CollapsibleTrigger />}
              className="w-full cursor-pointer"
              aria-label={`${tree.root.label} ${tree.root.projectsLabel}`}
            >
              <ChevronRight
                aria-hidden="true"
                className="size-3 shrink-0 transition-transform group-data-[open]/git-projects:rotate-90"
              />
              <Folder aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{tree.root.projectsLabel}</span>
            </SidebarMenuSubButton>
            <CollapsibleContent>
              {tree.nodes.length === 0 ? (
                <p className="px-6 py-1 text-xs text-muted-foreground" role="status">
                  No Git repositories found.
                </p>
              ) : (
                <SidebarMenuSub className="!mr-0 !pr-0">
                  {tree.nodes.map((node) =>
                    renderCloneTreeNode(
                      node,
                      favoriteKeys,
                      onFavoriteToggle,
                      onRepositorySelect,
                      openDirectoryIds,
                      setDirectoryOpen,
                    ),
                  )}
                </SidebarMenuSub>
              )}
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
      </SidebarMenu>
      <GitCloneTreeDiagnostics tree={tree} />
    </div>
  );
}

function renderCloneTreeNode(
  node: CloneTreeNode,
  favoriteKeys: GitCloneSidebarTreeProps["favoriteKeys"],
  onFavoriteToggle: GitCloneSidebarTreeProps["onFavoriteToggle"],
  onRepositorySelect: GitCloneSidebarTreeProps["onRepositorySelect"],
  openDirectoryIds: ReadonlySet<string>,
  setDirectoryOpen: (nodeId: string, open: boolean) => void,
) {
  if (node.kind === "repository") {
    return (
      <RepositoryTreeNode
        key={node.id}
        node={node}
        favoriteKeys={favoriteKeys}
        onFavoriteToggle={onFavoriteToggle}
        onRepositorySelect={onRepositorySelect}
      />
    );
  }

  return (
    <DirectoryTreeNode
      key={node.id}
      node={node}
      favoriteKeys={favoriteKeys}
      onFavoriteToggle={onFavoriteToggle}
      onRepositorySelect={onRepositorySelect}
      openDirectoryIds={openDirectoryIds}
      setDirectoryOpen={setDirectoryOpen}
    />
  );
}

function DirectoryTreeNode({
  node,
  favoriteKeys,
  onFavoriteToggle,
  onRepositorySelect,
  openDirectoryIds,
  setDirectoryOpen,
}: {
  node: Extract<CloneTreeNode, { kind: "directory" }>;
  favoriteKeys: GitCloneSidebarTreeProps["favoriteKeys"];
  onFavoriteToggle: GitCloneSidebarTreeProps["onFavoriteToggle"];
  onRepositorySelect: GitCloneSidebarTreeProps["onRepositorySelect"];
  openDirectoryIds: ReadonlySet<string>;
  setDirectoryOpen: (nodeId: string, open: boolean) => void;
}) {
  const isOpen = openDirectoryIds.has(node.id);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(open) => setDirectoryOpen(node.id, open)}
      className="group/git-directory"
    >
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          render={<CollapsibleTrigger />}
          className="w-full cursor-pointer"
          data-relative-path={node.relativePath}
          aria-label={`Open Git folder ${formatDisplayPath(node.displaySegments, node.label)}`}
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3 shrink-0 transition-transform group-data-[open]/git-directory:rotate-90"
          />
          <Folder aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{node.label}</span>
        </SidebarMenuSubButton>
        <CollapsibleContent>
          <SidebarMenuSub className="!mr-0 !pr-0">
            {node.children.map((child) =>
              renderCloneTreeNode(
                child,
                favoriteKeys,
                onFavoriteToggle,
                onRepositorySelect,
                openDirectoryIds,
                setDirectoryOpen,
              ),
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuSubItem>
    </Collapsible>
  );
}

function RepositoryTreeNode({
  node,
  favoriteKeys,
  onFavoriteToggle,
  onRepositorySelect,
}: {
  node: CloneTreeRepositoryNode;
  favoriteKeys: GitCloneSidebarTreeProps["favoriteKeys"];
  onFavoriteToggle: GitCloneSidebarTreeProps["onFavoriteToggle"];
  onRepositorySelect: GitCloneSidebarTreeProps["onRepositorySelect"];
}) {
  const displayPath = formatDisplayPath(node.displaySegments, node.label);
  const accessibleName = `Open Git repository ${displayPath}`;
  const isFavorited = favoriteKeys?.has(node.cloneSessionKey) === true;
  const favoriteAccessibleName = `${isFavorited ? "Remove" : "Add"} Git repository ${displayPath} ${
    isFavorited ? "from" : "to"
  } favorites`;

  const handleFavoriteClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onFavoriteToggle?.(node, !isFavorited);
  };

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        render={<button type="button" />}
        className="w-full cursor-pointer pr-10"
        aria-label={accessibleName}
        data-clone-session-key={node.cloneSessionKey}
        data-relative-path={node.relativePath}
        onClick={() => onRepositorySelect?.(node)}
      >
        <GitBranch aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{node.label}</span>
      </SidebarMenuSubButton>
      <button
        type="button"
        aria-label={favoriteAccessibleName}
        aria-pressed={isFavorited}
        className="absolute top-0 right-0 flex size-7 items-center justify-center rounded-md text-sidebar-foreground outline-hidden transition-colors after:absolute after:-inset-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:bg-sidebar-accent active:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden md:after:hidden"
        onClick={handleFavoriteClick}
      >
        <Star
          aria-hidden="true"
          className={cn("size-3.5", isFavorited && "fill-current text-sidebar-accent-foreground")}
        />
      </button>
    </SidebarMenuSubItem>
  );
}

function GitCloneTreeDiagnostics({ tree }: { tree: PublicCloneTree }) {
  const { diagnostics } = tree;
  const skippedCount = diagnostics.skippedPaths.length;

  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 px-2 py-1 text-[11px] text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden">
      <legend className="sr-only">Git clone scan diagnostics</legend>
      <span>Repos {diagnostics.repoCount}</span>
      <span aria-hidden="true">•</span>
      <span>Directories {diagnostics.directoryCount}</span>
      <span aria-hidden="true">•</span>
      <span>Skipped {skippedCount}</span>
      <span aria-hidden="true">•</span>
      <span>{diagnostics.truncated ? "Truncated" : "Complete"}</span>
      <span aria-hidden="true">•</span>
      <span>{diagnostics.durationMs}ms</span>
    </fieldset>
  );
}

function formatDisplayPath(displaySegments: readonly string[], fallback: string): string {
  const relativeSegments = displaySegments.slice(2).filter(Boolean);
  return relativeSegments.length > 0 ? relativeSegments.join(" / ") : fallback;
}
