"use client";

import { ChevronRight, Folder, GitBranch, Star } from "lucide-react";
import { type MouseEvent, useState } from "react";
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
  activeClonePath?: string | null;
  favoriteKeys?: ReadonlySet<string>;
  mutatingFavoriteKeys?: ReadonlySet<string>;
  onFavoriteToggle?: (repository: CloneTreeRepositoryNode, nextFavorited: boolean) => void;
  onRepositorySelect?: (repository: CloneTreeRepositoryNode) => void;
  className?: string;
}

export function GitCloneSidebarTree({
  tree,
  activeClonePath,
  favoriteKeys,
  mutatingFavoriteKeys,
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
                      activeClonePath,
                      favoriteKeys,
                      mutatingFavoriteKeys,
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
  activeClonePath: GitCloneSidebarTreeProps["activeClonePath"],
  favoriteKeys: GitCloneSidebarTreeProps["favoriteKeys"],
  mutatingFavoriteKeys: GitCloneSidebarTreeProps["mutatingFavoriteKeys"],
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
        isActive={activeClonePath === node.relativePath}
        favoriteKeys={favoriteKeys}
        mutatingFavoriteKeys={mutatingFavoriteKeys}
        onFavoriteToggle={onFavoriteToggle}
        onRepositorySelect={onRepositorySelect}
      />
    );
  }

  return (
    <DirectoryTreeNode
      key={node.id}
      node={node}
      activeClonePath={activeClonePath}
      favoriteKeys={favoriteKeys}
      mutatingFavoriteKeys={mutatingFavoriteKeys}
      onFavoriteToggle={onFavoriteToggle}
      onRepositorySelect={onRepositorySelect}
      openDirectoryIds={openDirectoryIds}
      setDirectoryOpen={setDirectoryOpen}
    />
  );
}

function DirectoryTreeNode({
  node,
  activeClonePath,
  favoriteKeys,
  mutatingFavoriteKeys,
  onFavoriteToggle,
  onRepositorySelect,
  openDirectoryIds,
  setDirectoryOpen,
}: {
  node: Extract<CloneTreeNode, { kind: "directory" }>;
  activeClonePath: GitCloneSidebarTreeProps["activeClonePath"];
  favoriteKeys: GitCloneSidebarTreeProps["favoriteKeys"];
  mutatingFavoriteKeys: GitCloneSidebarTreeProps["mutatingFavoriteKeys"];
  onFavoriteToggle: GitCloneSidebarTreeProps["onFavoriteToggle"];
  onRepositorySelect: GitCloneSidebarTreeProps["onRepositorySelect"];
  openDirectoryIds: ReadonlySet<string>;
  setDirectoryOpen: (nodeId: string, open: boolean) => void;
}) {
  const isOpen = openDirectoryIds.has(node.id) || containsClonePath(node, activeClonePath);

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
                activeClonePath,
                favoriteKeys,
                mutatingFavoriteKeys,
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
  isActive,
  favoriteKeys,
  mutatingFavoriteKeys,
  onFavoriteToggle,
  onRepositorySelect,
}: {
  node: CloneTreeRepositoryNode;
  isActive: boolean;
  favoriteKeys: GitCloneSidebarTreeProps["favoriteKeys"];
  mutatingFavoriteKeys: GitCloneSidebarTreeProps["mutatingFavoriteKeys"];
  onFavoriteToggle: GitCloneSidebarTreeProps["onFavoriteToggle"];
  onRepositorySelect: GitCloneSidebarTreeProps["onRepositorySelect"];
}) {
  const displayPath = formatDisplayPath(node.displaySegments, node.label);
  const accessibleName = `Open Git repository ${displayPath}`;
  const isFavorited = favoriteKeys?.has(node.cloneSessionKey) === true;
  const isMutatingFavorite = mutatingFavoriteKeys?.has(node.cloneSessionKey) === true;
  const favoriteAccessibleName = `${isFavorited ? "Remove" : "Add"} Git repository ${displayPath} ${
    isFavorited ? "from" : "to"
  } favorites`;

  const handleFavoriteClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isMutatingFavorite) return;
    onFavoriteToggle?.(node, !isFavorited);
  };

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        render={<button type="button" />}
        className="h-auto min-h-8 w-full cursor-pointer py-1 pr-10 text-left"
        isActive={isActive}
        aria-label={accessibleName}
        data-clone-session-key={node.cloneSessionKey}
        data-relative-path={node.relativePath}
        onClick={() => onRepositorySelect?.(node)}
      >
        <GitBranch aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{node.label}</span>
      </SidebarMenuSubButton>
      <button
        type="button"
        aria-label={favoriteAccessibleName}
        aria-pressed={isFavorited}
        disabled={isMutatingFavorite}
        className="absolute top-0 right-0 flex size-7 items-center justify-center rounded-md text-sidebar-foreground outline-hidden transition-colors after:absolute after:-inset-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-data-[collapsible=icon]:hidden md:after:hidden"
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

function containsClonePath(
  node: Extract<CloneTreeNode, { kind: "directory" }>,
  activeClonePath: string | null | undefined,
): boolean {
  if (!activeClonePath) return false;

  return node.children.some((child) => {
    if (child.kind === "repository") return child.relativePath === activeClonePath;
    return containsClonePath(child, activeClonePath);
  });
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
