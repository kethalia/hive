"use client";

import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Code,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GripVertical,
  Hexagon,
  LayoutDashboard,
  LayoutTemplate,
  ListTodo,
  Loader2,
  LogOut,
  Monitor,
  Pencil,
  Plus,
  PlusCircle,
  RefreshCw,
  Monitor as ScreenIcon,
  Settings,
  Star,
  Stethoscope,
  Terminal,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitCloneSidebarTree } from "@/components/git-clone-sidebar-tree";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSidebarMode } from "@/hooks/use-sidebar-mode";
import { listGitClonesAction, resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import {
  listNavigationFavoritesAction,
  type NavigationFavoriteDto,
  removeNavigationFavoriteAction,
  reorderNavigationFavoritesAction,
  upsertNavigationFavoriteAction,
} from "@/lib/actions/navigation-favorites";
import { listTemplateStatusesAction } from "@/lib/actions/templates";
import {
  getTerminalSettingsAction,
  updateTerminalSettingsAction,
} from "@/lib/actions/user-settings";
import { isTerminalSettingsDto } from "@/lib/actions/user-settings-contract";
import {
  createSessionAction,
  getWorkspaceAgentAction,
  getWorkspaceSessionsAction,
  killSessionAction,
  listWorkspacesAction,
  renameSessionAction,
  restartWorkspaceAction,
} from "@/lib/actions/workspaces";
import { refreshInstalledApp } from "@/lib/app-update";
import { getSessionAction } from "@/lib/auth/actions";
import type { CoderWorkspace, WorkspaceAgentStatus } from "@/lib/coder/types";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import type {
  GitCloneDiscoveryActionResult,
  GitCloneTerminalIdentity,
} from "@/lib/git/clone-actions-contract";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import type { CloneTreeDiagnostics, CloneTreeRepositoryNode } from "@/lib/git/clone-tree";
import type { TemplateStatus } from "@/lib/templates/staleness";
import { dispatchTerminalSettingsChanged } from "@/lib/terminal/settings-events";
import { cn } from "@/lib/utils";
import type { TmuxSession } from "@/lib/workspaces/sessions";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";

const POLL_INTERVAL_MS = 30_000;

function useRelativeTime(date: Date | null, enabled: boolean): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!date || !enabled) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [date, enabled]);

  if (!date) return "Never";
  const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1_000));
  if (diffSec < 5) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

interface SectionState<T> {
  data: T[];
  isLoading: boolean;
  error: string | null;
}

interface WorkspaceSessionState {
  data: TmuxSession[];
  isLoading: boolean;
  error: string | null;
}

interface GitDiscoveryState {
  result: GitCloneDiscoveryActionResult | null;
  isLoading: boolean;
  serverError: string | null;
}

interface FavoritesState {
  data: NavigationFavoriteDto[];
  isLoading: boolean;
  error: string | null;
  mutatingKeys: ReadonlySet<string>;
}

const GIT_DISCOVERY_SERVER_ERROR_MESSAGE =
  "Git clone discovery is unavailable. Refresh and try again.";
const GIT_TERMINAL_OPEN_ERROR_MESSAGE =
  "We couldn't open that Git repository. Refresh and try again.";
const FAVORITES_UNAVAILABLE_MESSAGE = "Favorites unavailable. Terminal access is still available.";
const TERMINAL_SETTINGS_ERROR_MESSAGE = "Terminal controls setting unavailable.";
const TERMINAL_CONTROLS_SWITCH_ID = "terminal-controls-beyond-mobile";
const TERMINAL_CONTROLS_SWITCH_LABEL_ID = `${TERMINAL_CONTROLS_SWITCH_ID}-label`;
const TERMINAL_CONTROLS_SWITCH_DESCRIPTION_ID = `${TERMINAL_CONTROLS_SWITCH_ID}-description`;
const TERMINAL_CONTROLS_SWITCH_ERROR_ID = `${TERMINAL_CONTROLS_SWITCH_ID}-error`;
function isGitCloneTerminalIdentity(value: unknown): value is GitCloneTerminalIdentity {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<GitCloneTerminalIdentity>;
  return (
    typeof candidate.sessionName === "string" &&
    candidate.sessionName.length > 0 &&
    typeof candidate.clonePath === "string" &&
    candidate.clonePath.length > 0 &&
    typeof candidate.cloneSessionKey === "string" &&
    candidate.cloneSessionKey.length > 0 &&
    typeof candidate.cloneProof === "string" &&
    candidate.cloneProof.length > 0
  );
}

function favoriteIdentity(
  kind: NavigationFavoriteDto["kind"],
  workspaceId: string,
  targetKey: string,
) {
  return `${kind}:${workspaceId}:${targetKey}`;
}

function isNavigationFavoriteDto(value: unknown): value is NavigationFavoriteDto {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<NavigationFavoriteDto>;
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "terminal" || candidate.kind === "git") &&
    typeof candidate.workspaceId === "string" &&
    candidate.workspaceId.length > 0 &&
    typeof candidate.targetKey === "string" &&
    candidate.targetKey.length > 0 &&
    (typeof candidate.label === "string" || candidate.label === null) &&
    (typeof candidate.relativePath === "string" || candidate.relativePath === null) &&
    typeof candidate.createdAt === "string"
  );
}

function dedupeFavorites(favorites: NavigationFavoriteDto[]): NavigationFavoriteDto[] {
  const byKey = new Map<string, NavigationFavoriteDto>();
  for (const favorite of favorites) {
    const key = favoriteIdentity(favorite.kind, favorite.workspaceId, favorite.targetKey);
    if (!byKey.has(key)) byKey.set(key, favorite);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

function isSafeFavoriteLabel(label: string | null): label is string {
  if (!label) return false;
  const value = label.trim();
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) &&
    !/cloneProof=/i.test(value) &&
    !/[\r\n\0]/.test(value)
  );
}

function favoriteLabel(favorite: NavigationFavoriteDto): string {
  if (isSafeFavoriteLabel(favorite.label)) return favorite.label.trim();
  if (favorite.kind === "git") return favorite.relativePath ?? "Git repository";
  return favorite.targetKey;
}

interface AgentInfo {
  agentId: string;
  agentName: string;
  agentStatus: WorkspaceAgentStatus;
}

const SESSION_MAX_HEIGHT = 160;

function SessionList({
  sessions,
  workspaceId,
  pathname,
  activeSession,
  favoriteKeys,
  mutatingFavoriteKeys,
  onFavoriteToggle,
  onKill,
  onRename,
}: {
  sessions: TmuxSession[];
  workspaceId: string;
  pathname: string;
  activeSession: string | null;
  favoriteKeys: ReadonlySet<string>;
  mutatingFavoriteKeys: ReadonlySet<string>;
  onFavoriteToggle: (workspaceId: string, sessionName: string, nextFavorited: boolean) => void;
  onKill: (workspaceId: string, sessionName: string) => void;
  onRename: (workspaceId: string, oldName: string, newName: string) => void;
}) {
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const mobileSessionRowClassName = isMobile ? "min-h-11 py-2 text-sm" : undefined;
  const actionVisibilityClassName = isMobile
    ? "opacity-100"
    : "opacity-0 group-hover/session-row:opacity-100 focus-within:opacity-100";
  const actionButtonClassName = isMobile
    ? "flex h-11 w-11 items-center justify-center p-0"
    : "p-0.5";

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasOverflow = el.scrollHeight > el.clientHeight;
    setCanScroll(hasOverflow);
    setIsAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
  }, []);

  useEffect(() => {
    checkScroll();
  }, [checkScroll]);

  const startRename = useCallback((sessionName: string) => {
    setEditingSession(sessionName);
    setEditValue(sessionName);
  }, []);

  const commitRename = useCallback(
    (oldName: string) => {
      const trimmed = editValue.trim();
      setEditingSession(null);
      if (!trimmed || trimmed === oldName || !SAFE_IDENTIFIER_RE.test(trimmed)) return;
      onRename(workspaceId, oldName, trimmed);
    },
    [editValue, onRename, workspaceId],
  );

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        data-testid={`session-list-scroll-${workspaceId}`}
        className="overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={isMobile ? undefined : { maxHeight: SESSION_MAX_HEIGHT }}
        onScroll={checkScroll}
      >
        {sessions.map((session) => {
          const favoriteKey = favoriteIdentity("terminal", workspaceId, session.name);
          const isFavorited = favoriteKeys.has(favoriteKey);
          const isMutatingFavorite = mutatingFavoriteKeys.has(favoriteKey);

          return (
            <SidebarMenuSubItem key={session.name} className="group/session-row">
              {editingSession === session.name ? (
                <SidebarMenuSubButton className={cn("cursor-text", mobileSessionRowClassName)}>
                  <Terminal className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <Input
                    data-testid={`rename-session-input-${session.name}`}
                    className="h-5 flex-1 rounded border-none bg-transparent px-0 py-0 font-mono text-xs shadow-none focus-visible:ring-0"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(session.name);
                      else if (e.key === "Escape") setEditingSession(null);
                    }}
                    onBlur={() => commitRename(session.name)}
                    autoFocus
                  />
                </SidebarMenuSubButton>
              ) : (
                <>
                  <SidebarMenuSubButton
                    render={
                      <Link
                        href={`/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(session.name)}`}
                      />
                    }
                    isActive={
                      pathname === `/workspaces/${workspaceId}/terminal` &&
                      activeSession === session.name
                    }
                    className={cn("pr-24", mobileSessionRowClassName)}
                  >
                    <Terminal className="h-3 w-3 shrink-0" />
                    <span className="truncate">{session.name}</span>
                  </SidebarMenuSubButton>
                  <span
                    className={cn(
                      "absolute inset-y-0 right-1 flex items-center gap-0.5",
                      actionVisibilityClassName,
                    )}
                  >
                    <button
                      type="button"
                      title={isFavorited ? "Remove from favorites" : "Add to favorites"}
                      aria-label={`${isFavorited ? "Remove" : "Add"} terminal session ${session.name} ${
                        isFavorited ? "from" : "to"
                      } favorites`}
                      aria-pressed={isFavorited}
                      data-testid={`favorite-terminal-session-${session.name}`}
                      disabled={isMutatingFavorite}
                      className={cn(
                        "rounded hover:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50",
                        actionButtonClassName,
                      )}
                      onClick={() => {
                        onFavoriteToggle(workspaceId, session.name, !isFavorited);
                      }}
                    >
                      <Star className={cn("h-3 w-3", isFavorited && "fill-current")} />
                    </button>
                    <button
                      type="button"
                      title="Rename session"
                      aria-label={`Rename session ${session.name}`}
                      data-testid={`rename-session-${session.name}`}
                      className={cn("rounded hover:bg-sidebar-accent", actionButtonClassName)}
                      onClick={() => {
                        startRename(session.name);
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Kill session"
                      aria-label={`Kill session ${session.name}`}
                      data-testid={`kill-session-${session.name}`}
                      className={cn("rounded hover:bg-destructive/20", actionButtonClassName)}
                      onClick={() => {
                        onKill(workspaceId, session.name);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                </>
              )}
            </SidebarMenuSubItem>
          );
        })}
      </div>
      {canScroll && !isAtBottom && (
        <button
          type="button"
          data-testid={`scroll-sessions-${workspaceId}`}
          className="absolute bottom-0 left-0 right-0 flex items-center justify-center bg-gradient-to-t from-sidebar from-60% to-transparent py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          <ChevronDown className="h-3 w-3" />
          <span className="ml-1">More sessions</span>
        </button>
      )}
    </div>
  );
}

function FavoritesSection({
  favorites,
  pathname,
  activeSession,
  activeClonePath,
  onGitFavoriteLaunch,
  onReorder,
}: {
  favorites: FavoritesState;
  pathname: string;
  activeSession: string | null;
  activeClonePath: string | null;
  onGitFavoriteLaunch: (favorite: NavigationFavoriteDto) => void;
  onReorder: (favoriteIds: string[]) => void;
}) {
  const visibleFavorites = useMemo(() => dedupeFavorites(favorites.data), [favorites.data]);
  const [draggedFavoriteId, setDraggedFavoriteId] = useState<string | null>(null);

  const reorderAround = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const next = [...visibleFavorites];
    const sourceIndex = next.findIndex((favorite) => favorite.id === sourceId);
    const targetIndex = next.findIndex((favorite) => favorite.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next.map((favorite) => favorite.id));
  };

  const moveByKeyboard = (favoriteId: string, direction: -1 | 1) => {
    const index = visibleFavorites.findIndex((favorite) => favorite.id === favoriteId);
    const target = visibleFavorites[index + direction];
    if (target) reorderAround(favoriteId, target.id);
  };

  const dragHandle = (favorite: NavigationFavoriteDto) => (
    <button
      type="button"
      draggable
      aria-label={`Reorder ${favoriteLabel(favorite)}`}
      className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:cursor-grabbing max-md:size-11"
      onDragStart={(event) => {
        setDraggedFavoriteId(favorite.id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", favorite.id);
        const row = event.currentTarget.parentElement;
        if (row) {
          const preview = row.cloneNode(true);
          if (!(preview instanceof HTMLElement)) return;
          const bounds = row.getBoundingClientRect();
          preview.setAttribute("aria-hidden", "true");
          preview.dataset.dragPreview = "pinned-row";
          preview.style.position = "fixed";
          preview.style.inset = "-1000px auto auto -1000px";
          preview.style.width = `${Math.max(bounds.width, 220)}px`;
          preview.style.height = `${Math.max(bounds.height, 32)}px`;
          preview.style.padding = "2px";
          preview.style.background = "hsl(var(--sidebar))";
          preview.style.border = "1px solid hsl(var(--sidebar-border))";
          preview.style.borderRadius = "0.5rem";
          preview.style.boxShadow = "0 10px 28px rgb(0 0 0 / 35%)";
          preview.style.opacity = "0.96";
          preview.style.pointerEvents = "none";
          document.body.append(preview);
          event.dataTransfer.setDragImage(preview, 16, Math.round(Math.max(bounds.height, 32) / 2));
          window.setTimeout(() => preview.remove(), 0);
        }
      }}
      onDragEnd={() => setDraggedFavoriteId(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          moveByKeyboard(favorite.id, event.key === "ArrowUp" ? -1 : 1);
        }
      }}
    >
      <GripVertical aria-hidden="true" className="size-4" />
    </button>
  );

  if (!favorites.isLoading && visibleFavorites.length === 0 && !favorites.error) return null;

  return (
    <SidebarGroup className="pb-0" data-testid="favorites-section">
      <SidebarGroupLabel>Pinned</SidebarGroupLabel>
      <SidebarGroupContent>
        {favorites.error && (
          <Alert variant="destructive" className="mx-4 my-1" data-testid="favorites-error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <span className="text-xs">{favorites.error}</span>
            </AlertDescription>
          </Alert>
        )}
        {favorites.isLoading && visibleFavorites.length === 0 && (
          <p className="px-6 py-2 text-xs text-muted-foreground" role="status">
            Loading pinned items…
          </p>
        )}
        {visibleFavorites.length > 0 && (
          <SidebarMenu>
            {visibleFavorites.map((favorite) => {
              const label = favoriteLabel(favorite);
              if (favorite.kind === "terminal") {
                return (
                  <SidebarMenuItem
                    key={favorite.id}
                    className="flex items-center gap-1"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      reorderAround(
                        draggedFavoriteId ?? event.dataTransfer.getData("text/plain"),
                        favorite.id,
                      );
                      setDraggedFavoriteId(null);
                    }}
                  >
                    <SidebarMenuButton
                      render={
                        <Link
                          href={`/workspaces/${encodeURIComponent(
                            favorite.workspaceId,
                          )}/terminal?session=${encodeURIComponent(favorite.targetKey)}`}
                        />
                      }
                      isActive={
                        pathname === `/workspaces/${favorite.workspaceId}/terminal` &&
                        !activeClonePath &&
                        activeSession === favorite.targetKey
                      }
                      data-testid={`favorite-terminal-link-${favorite.workspaceId}-${favorite.targetKey}`}
                      className="min-w-0 flex-1"
                    >
                      <Terminal className="h-4 w-4" />
                      <span className="truncate">{label}</span>
                    </SidebarMenuButton>
                    {dragHandle(favorite)}
                  </SidebarMenuItem>
                );
              }

              const canLaunch =
                typeof favorite.relativePath === "string" && favorite.relativePath.length > 0;
              return (
                <SidebarMenuItem
                  key={favorite.id}
                  className="flex items-center gap-1"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    reorderAround(
                      draggedFavoriteId ?? event.dataTransfer.getData("text/plain"),
                      favorite.id,
                    );
                    setDraggedFavoriteId(null);
                  }}
                >
                  <SidebarMenuButton
                    disabled={!canLaunch}
                    className={cn(
                      "min-w-0 flex-1 cursor-pointer",
                      !canLaunch && "cursor-not-allowed opacity-50",
                    )}
                    isActive={
                      pathname === `/workspaces/${favorite.workspaceId}/terminal` &&
                      activeClonePath === favorite.relativePath
                    }
                    data-testid={`favorite-git-link-${favorite.workspaceId}-${favorite.targetKey}`}
                    onClick={() => {
                      if (canLaunch) onGitFavoriteLaunch(favorite);
                    }}
                  >
                    <GitBranch className="h-4 w-4" />
                    <span className="truncate">{label}</span>
                  </SidebarMenuButton>
                  {dragHandle(favorite)}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function GitDiscoveryPanel({
  state,
  activeClonePath,
  favoriteKeys,
  mutatingFavoriteKeys,
  onFavoriteToggle,
  onRetry,
  onRepositorySelect,
}: {
  state: GitDiscoveryState;
  activeClonePath: string | null;
  favoriteKeys: ReadonlySet<string>;
  mutatingFavoriteKeys: ReadonlySet<string>;
  onFavoriteToggle: (repository: CloneTreeRepositoryNode, nextFavorited: boolean) => void;
  onRetry: () => void;
  onRepositorySelect: (repository: CloneTreeRepositoryNode) => void;
}) {
  if (state.isLoading && !state.result && !state.serverError) {
    return (
      <p className="px-6 py-2 text-xs text-muted-foreground" role="status">
        Loading Git repositories…
      </p>
    );
  }

  if (state.serverError) {
    return (
      <GitDiscoveryNotice
        status="server-error"
        title="Git scan unavailable"
        message={state.serverError}
        diagnostics={null}
        tone="error"
        onRetry={onRetry}
      />
    );
  }

  const result = state.result;
  if (!result) return null;

  if (!result.ok) {
    return (
      <GitDiscoveryNotice
        status={result.status}
        title={result.status === "missing-root" ? "Home root unavailable" : "Git scan failed"}
        message={result.message}
        diagnostics={result.diagnostics}
        tone="error"
        onRetry={onRetry}
      />
    );
  }

  if (result.status === "empty") {
    return (
      <div className="space-y-1" data-testid="git-discovery-empty-state">
        <GitDiscoveryNotice
          status="empty"
          title="No Git repositories found"
          message={result.message}
          diagnostics={null}
          tone="neutral"
          onRetry={onRetry}
        />
        <GitCloneSidebarTree
          tree={result.tree}
          activeClonePath={activeClonePath}
          favoriteKeys={favoriteKeys}
          mutatingFavoriteKeys={mutatingFavoriteKeys}
          onFavoriteToggle={onFavoriteToggle}
          onRepositorySelect={onRepositorySelect}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid="git-discovery-success">
      {state.isLoading && (
        <p className="px-6 py-1 text-xs text-muted-foreground" role="status">
          Refreshing Git repositories…
        </p>
      )}
      <GitCloneSidebarTree
        tree={result.tree}
        activeClonePath={activeClonePath}
        favoriteKeys={favoriteKeys}
        mutatingFavoriteKeys={mutatingFavoriteKeys}
        onFavoriteToggle={onFavoriteToggle}
        onRepositorySelect={onRepositorySelect}
      />
    </div>
  );
}

function GitDiscoveryNotice({
  status,
  title,
  message,
  diagnostics,
  tone,
  onRetry,
}: {
  status: "empty" | "missing-root" | "scan-failed" | "server-error";
  title: string;
  message: string;
  diagnostics: CloneTreeDiagnostics | null;
  tone: "error" | "neutral";
  onRetry: () => void;
}) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{message}</p>
        {diagnostics && <GitDiscoveryDiagnostics diagnostics={diagnostics} />}
      </div>
      <button
        type="button"
        data-testid="git-discovery-retry"
        onClick={onRetry}
        className="ml-2 text-xs underline"
      >
        Retry
      </button>
    </>
  );

  if (tone === "error") {
    return (
      <Alert variant="destructive" className="mx-4 my-1" data-testid={`git-discovery-${status}`}>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription className="flex items-start justify-between gap-2">
          {body}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div
      role="status"
      data-testid={`git-discovery-${status}`}
      className="mx-4 my-1 flex items-start justify-between gap-2 rounded-md border border-sidebar-border px-3 py-2"
    >
      {body}
    </div>
  );
}

function GitDiscoveryDiagnostics({ diagnostics }: { diagnostics: CloneTreeDiagnostics }) {
  return (
    <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
      Repos {diagnostics.repoCount} · Directories {diagnostics.directoryCount} · Skipped{" "}
      {diagnostics.skippedPaths.length} · {diagnostics.truncated ? "Truncated" : "Complete"} ·{" "}
      {diagnostics.durationMs}ms
    </p>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSession = searchParams.get("session");
  const activeClonePath = searchParams.get("clonePath");
  const [sidebarMode] = useSidebarMode();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalControlsBeyondMobile, setTerminalControlsBeyondMobile] = useState(false);
  const [isTerminalSettingsLoading, setIsTerminalSettingsLoading] = useState(true);
  const [isTerminalSettingsUpdating, setIsTerminalSettingsUpdating] = useState(false);
  const [terminalSettingsError, setTerminalSettingsError] = useState<string | null>(null);

  const [sessionUser, setSessionUser] = useState<{
    email: string;
    coderUrl: string;
  } | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    getSessionAction().then((result) => {
      if (result?.data?.user) {
        setSessionUser(result.data.user);
      }
    });
  }, []);

  const loadTerminalSettings = useCallback(async () => {
    setIsTerminalSettingsLoading(true);
    setTerminalSettingsError(null);
    try {
      const result = await getTerminalSettingsAction();
      if (isTerminalSettingsDto(result?.data)) {
        setTerminalControlsBeyondMobile(result.data.terminalControlsBeyondMobile);
      } else if (result?.serverError) {
        setTerminalControlsBeyondMobile(false);
        setTerminalSettingsError(TERMINAL_SETTINGS_ERROR_MESSAGE);
      } else {
        setTerminalControlsBeyondMobile(false);
      }
    } catch {
      setTerminalControlsBeyondMobile(false);
      setTerminalSettingsError(TERMINAL_SETTINGS_ERROR_MESSAGE);
    } finally {
      setIsTerminalSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTerminalSettings();
  }, [loadTerminalSettings]);

  const handleTerminalControlsBeyondMobileChange = useCallback(
    async (nextValue: boolean) => {
      if (isTerminalSettingsLoading || isTerminalSettingsUpdating) return;

      const previousValue = terminalControlsBeyondMobile;
      setTerminalControlsBeyondMobile(nextValue);
      setIsTerminalSettingsUpdating(true);
      setTerminalSettingsError(null);

      try {
        const result = await updateTerminalSettingsAction({
          terminalControlsBeyondMobile: nextValue,
        });
        if (!isTerminalSettingsDto(result?.data)) {
          throw new Error("terminal_settings_update_failed");
        }

        const savedValue = result.data.terminalControlsBeyondMobile;
        setTerminalControlsBeyondMobile(savedValue);
        dispatchTerminalSettingsChanged({ terminalControlsBeyondMobile: savedValue });
        router.refresh();
      } catch {
        setTerminalControlsBeyondMobile(previousValue);
        setTerminalSettingsError(TERMINAL_SETTINGS_ERROR_MESSAGE);
      } finally {
        setIsTerminalSettingsUpdating(false);
      }
    },
    [isTerminalSettingsLoading, isTerminalSettingsUpdating, router, terminalControlsBeyondMobile],
  );

  const coderUrl = sessionUser?.coderUrl ?? undefined;
  const navigateInternal = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router],
  );

  const [workspacesOpen, setWorkspacesOpen] = useState(true);
  const [templatesOpen, setTemplatesOpen] = useState(true);

  const [workspaces, setWorkspaces] = useState<SectionState<CoderWorkspace>>({
    data: [],
    isLoading: true,
    error: null,
  });
  const [templates, setTemplates] = useState<SectionState<TemplateStatus>>({
    data: [],
    isLoading: true,
    error: null,
  });
  const [favorites, setFavorites] = useState<FavoritesState>({
    data: [],
    isLoading: true,
    error: null,
    mutatingKeys: new Set(),
  });
  const [workspaceGitDiscovery, setWorkspaceGitDiscovery] = useState<
    Record<string, GitDiscoveryState>
  >({});
  const [workspaceGitTerminalErrors, setWorkspaceGitTerminalErrors] = useState<
    Record<string, string | null>
  >({});
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const relativeTime = useRelativeTime(lastRefreshed, settingsOpen);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [expandedGitSections, setExpandedGitSections] = useState<Record<string, boolean>>({});
  const [expandedTerminals, setExpandedTerminals] = useState<Record<string, boolean>>({});
  const [workspaceAgents, setWorkspaceAgents] = useState<Record<string, AgentInfo | null>>({});
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, WorkspaceSessionState>>(
    {},
  );
  const [restartingWorkspaces, setRestartingWorkspaces] = useState<Set<string>>(new Set());

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIntervalRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const sessionsInFlightRef = useRef<Set<string>>(new Set());

  const fetchWorkspaces = useCallback(async () => {
    setWorkspaces((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const result = await listWorkspacesAction();
      if (result?.data) {
        setWorkspaces({ data: result.data, isLoading: false, error: null });
        setLastRefreshed(new Date());
      } else {
        const msg = result?.serverError ?? "Failed to fetch workspaces";
        setWorkspaces((prev) => ({ ...prev, isLoading: false, error: msg }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch workspaces";
      setWorkspaces((prev) => ({ ...prev, isLoading: false, error: msg }));
    }
  }, []);

  const fetchTemplates = useCallback(async () => {
    setTemplates((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const result = await listTemplateStatusesAction();
      if (result?.data) {
        setTemplates({ data: result.data, isLoading: false, error: null });
        setLastRefreshed(new Date());
      } else {
        const msg = result?.serverError ?? "Failed to fetch templates";
        setTemplates((prev) => ({ ...prev, isLoading: false, error: msg }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch templates";
      setTemplates((prev) => ({ ...prev, isLoading: false, error: msg }));
    }
  }, []);

  const loadedFavoriteWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const fetchFavoritesForWorkspaces = useCallback(async (workspaceIds: string[]) => {
    const pendingWorkspaceIds = workspaceIds.filter(
      (workspaceId) => !loadedFavoriteWorkspaceIdsRef.current.has(workspaceId),
    );
    if (pendingWorkspaceIds.length === 0) {
      setFavorites((prev) => ({ ...prev, isLoading: false }));
      return;
    }

    for (const workspaceId of pendingWorkspaceIds) {
      loadedFavoriteWorkspaceIdsRef.current.add(workspaceId);
    }

    setFavorites((prev) => ({ ...prev, isLoading: true, error: null }));
    const settledResults = await Promise.allSettled(
      pendingWorkspaceIds.map((workspaceId) => listNavigationFavoritesAction({ workspaceId })),
    );

    const nextFavorites: NavigationFavoriteDto[] = [];
    let failed = false;
    for (const result of settledResults) {
      if (result.status === "rejected") {
        failed = true;
        continue;
      }

      const data = result.value?.data;
      if (!Array.isArray(data) || !data.every(isNavigationFavoriteDto)) {
        failed = true;
        continue;
      }
      nextFavorites.push(...data);
    }

    setFavorites((prev) => ({
      ...prev,
      data: dedupeFavorites([...prev.data, ...nextFavorites]),
      isLoading: false,
      error: failed ? FAVORITES_UNAVAILABLE_MESSAGE : null,
    }));
  }, []);

  const fetchGitClones = useCallback(async (workspaceId: string) => {
    setWorkspaceGitDiscovery((prev) => ({
      ...prev,
      [workspaceId]: {
        result: prev[workspaceId]?.result ?? null,
        isLoading: true,
        serverError: null,
      },
    }));
    try {
      const result = await listGitClonesAction({ workspaceId });
      if (result?.data) {
        const data = result.data;
        setWorkspaceGitDiscovery((prev) => ({
          ...prev,
          [workspaceId]: { result: data, isLoading: false, serverError: null },
        }));
        return;
      }
    } catch {
      // Fall through to the sanitized server-error state below.
    }

    setWorkspaceGitDiscovery((prev) => ({
      ...prev,
      [workspaceId]: {
        result: null,
        isLoading: false,
        serverError: GIT_DISCOVERY_SERVER_ERROR_MESSAGE,
      },
    }));
  }, []);

  const fetchAgentInfo = useCallback(async (workspaceId: string) => {
    try {
      const result = await getWorkspaceAgentAction({ workspaceId });
      if (result?.data) {
        const agentInfo = result.data;
        setWorkspaceAgents((prev) => ({ ...prev, [workspaceId]: agentInfo }));
        return agentInfo;
      }
    } catch {
      // fall through to null
    }
    setWorkspaceAgents((prev) => ({ ...prev, [workspaceId]: null }));
    return null;
  }, []);

  const fetchSessions = useCallback(async (workspaceId: string) => {
    if (sessionsInFlightRef.current.has(workspaceId)) return;
    sessionsInFlightRef.current.add(workspaceId);
    setWorkspaceSessions((prev) => ({
      ...prev,
      [workspaceId]: { ...(prev[workspaceId] ?? { data: [] }), isLoading: true, error: null },
    }));
    try {
      const result = await getWorkspaceSessionsAction({ workspaceId });
      if (result?.data) {
        const sessions = result.data.filter((session) => !isCloneTerminalSessionName(session.name));
        setWorkspaceSessions((prev) => ({
          ...prev,
          [workspaceId]: { data: sessions, isLoading: false, error: null },
        }));
      } else {
        const msg = result?.serverError ?? "Failed to load sessions";
        setWorkspaceSessions((prev) => ({
          ...prev,
          [workspaceId]: { ...(prev[workspaceId] ?? { data: [] }), isLoading: false, error: msg },
        }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load sessions";
      setWorkspaceSessions((prev) => ({
        ...prev,
        [workspaceId]: { ...(prev[workspaceId] ?? { data: [] }), isLoading: false, error: msg },
      }));
    } finally {
      sessionsInFlightRef.current.delete(workspaceId);
    }
  }, []);

  const handleRestartWorkspace = useCallback(
    async (workspaceId: string) => {
      setRestartingWorkspaces((prev) => new Set(prev).add(workspaceId));
      try {
        const result = await restartWorkspaceAction({ workspaceId });
        if (!result?.data) {
          const message = result?.serverError ?? "Failed to restart workspace";
          setWorkspaceSessions((prev) => ({
            ...prev,
            [workspaceId]: {
              ...(prev[workspaceId] ?? { data: [] }),
              isLoading: false,
              error: message,
            },
          }));
          return;
        }
        await fetchWorkspaces();
        const agent = await fetchAgentInfo(workspaceId);
        if (agent?.agentStatus === "connected") {
          await fetchSessions(workspaceId);
        } else {
          setWorkspaceSessions((prev) => ({
            ...prev,
            [workspaceId]: {
              ...(prev[workspaceId] ?? { data: [] }),
              isLoading: false,
              error: "Workspace restarted. Its agent is still connecting; retry in a moment.",
            },
          }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to restart workspace";
        setWorkspaceSessions((prev) => ({
          ...prev,
          [workspaceId]: {
            ...(prev[workspaceId] ?? { data: [] }),
            isLoading: false,
            error: message,
          },
        }));
      } finally {
        setRestartingWorkspaces((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
      }
    },
    [fetchAgentInfo, fetchSessions, fetchWorkspaces],
  );

  const expandedWorkspacesRef = useRef(expandedWorkspaces);
  expandedWorkspacesRef.current = expandedWorkspaces;
  const expandedGitSectionsRef = useRef(expandedGitSections);
  expandedGitSectionsRef.current = expandedGitSections;

  const refreshExpandedGitClones = useCallback(() => {
    for (const [wsId, isExpanded] of Object.entries(expandedGitSectionsRef.current)) {
      if (isExpanded) fetchGitClones(wsId);
    }
  }, [fetchGitClones]);

  const fetchWorkspaceAndTemplates = useCallback(() => {
    fetchWorkspaces();
    fetchTemplates();
  }, [fetchWorkspaces, fetchTemplates]);

  const fetchAll = useCallback(() => {
    fetchWorkspaceAndTemplates();
    refreshExpandedGitClones();
  }, [fetchWorkspaceAndTemplates, refreshExpandedGitClones]);

  useEffect(() => {
    fetchWorkspaceAndTemplates();
    intervalRef.current = setInterval(fetchWorkspaceAndTemplates, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchWorkspaceAndTemplates]);

  useEffect(() => {
    if (workspaces.isLoading) return;
    fetchFavoritesForWorkspaces(workspaces.data.map((workspace) => workspace.id));
  }, [fetchFavoritesForWorkspaces, workspaces.data, workspaces.isLoading]);

  const refreshSessions = useCallback(() => {
    for (const [wsId, isExpanded] of Object.entries(expandedWorkspacesRef.current)) {
      if (isExpanded) fetchSessions(wsId);
    }
  }, [fetchSessions]);

  useEffect(() => {
    const handleSidebarRefresh = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.workspaceId) {
        fetchSessions(detail.workspaceId);
      } else {
        refreshSessions();
      }
    };
    window.addEventListener("hive:sidebar-refresh", handleSidebarRefresh);
    return () => {
      window.removeEventListener("hive:sidebar-refresh", handleSidebarRefresh);
    };
  }, [refreshSessions, fetchSessions]);

  const workspaceAgentsRef = useRef(workspaceAgents);
  workspaceAgentsRef.current = workspaceAgents;

  const handleWorkspaceExpand = useCallback(
    (workspaceId: string, open: boolean) => {
      setExpandedWorkspaces((prev) => ({ ...prev, [workspaceId]: open }));
      if (open) {
        if (!workspaceAgentsRef.current[workspaceId]) {
          fetchAgentInfo(workspaceId);
        }
        fetchSessions(workspaceId);
        fetchGitClones(workspaceId);
      }
    },
    [fetchAgentInfo, fetchGitClones, fetchSessions],
  );

  const handleGitSectionExpand = useCallback(
    (workspaceId: string, open: boolean) => {
      setExpandedGitSections((prev) => ({ ...prev, [workspaceId]: open }));
      if (open) fetchGitClones(workspaceId);
    },
    [fetchGitClones],
  );

  const activeWorkspaceId = useMemo(() => {
    const match = pathname.match(/^\/workspaces\/([^/]+)/);
    return match ? match[1] : null;
  }, [pathname]);

  const autoExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (autoExpandedRef.current === activeWorkspaceId) return;
    if (!workspaces.data.some((w) => w.id === activeWorkspaceId)) return;
    autoExpandedRef.current = activeWorkspaceId;
    setExpandedWorkspaces((prev) =>
      prev[activeWorkspaceId] ? prev : { ...prev, [activeWorkspaceId]: true },
    );
    if (!workspaceAgentsRef.current[activeWorkspaceId]) {
      fetchAgentInfo(activeWorkspaceId);
    }
    fetchSessions(activeWorkspaceId);
    fetchGitClones(activeWorkspaceId);
  }, [activeWorkspaceId, workspaces.data, fetchAgentInfo, fetchGitClones, fetchSessions]);

  useEffect(() => {
    const refs = sessionIntervalRefs.current;
    for (const [wsId, isExpanded] of Object.entries(expandedWorkspaces)) {
      if (isExpanded && !refs[wsId]) {
        refs[wsId] = setInterval(() => fetchSessions(wsId), POLL_INTERVAL_MS);
      } else if (!isExpanded && refs[wsId]) {
        clearInterval(refs[wsId]);
        delete refs[wsId];
      }
    }
    return () => {
      for (const id of Object.keys(refs)) {
        clearInterval(refs[id]);
        delete refs[id];
      }
    };
  }, [expandedWorkspaces, fetchSessions]);

  const favoriteKeySet = useMemo(
    () =>
      new Set(
        favorites.data.map((favorite) =>
          favoriteIdentity(favorite.kind, favorite.workspaceId, favorite.targetKey),
        ),
      ),
    [favorites.data],
  );

  const gitFavoriteKeysByWorkspace = useMemo(() => {
    const byWorkspace = new Map<string, Set<string>>();
    for (const favorite of favorites.data) {
      if (favorite.kind !== "git") continue;
      const keys = byWorkspace.get(favorite.workspaceId) ?? new Set<string>();
      keys.add(favorite.targetKey);
      byWorkspace.set(favorite.workspaceId, keys);
    }
    return byWorkspace;
  }, [favorites.data]);

  const mutatingGitFavoriteKeysByWorkspace = useMemo(() => {
    const byWorkspace = new Map<string, Set<string>>();
    for (const key of favorites.mutatingKeys) {
      if (!key.startsWith("git:")) continue;
      const workspaceAndTarget = key.slice("git:".length);
      const separatorIndex = workspaceAndTarget.indexOf(":");
      if (separatorIndex === -1) continue;
      const workspaceId = workspaceAndTarget.slice(0, separatorIndex);
      const targetKey = workspaceAndTarget.slice(separatorIndex + 1);
      const keys = byWorkspace.get(workspaceId) ?? new Set<string>();
      keys.add(targetKey);
      byWorkspace.set(workspaceId, keys);
    }
    return byWorkspace;
  }, [favorites.mutatingKeys]);

  const setFavoriteMutating = useCallback((key: string, isMutating: boolean) => {
    setFavorites((prev) => {
      const mutatingKeys = new Set(prev.mutatingKeys);
      if (isMutating) {
        mutatingKeys.add(key);
      } else {
        mutatingKeys.delete(key);
      }
      return { ...prev, mutatingKeys };
    });
  }, []);

  const handleFavoriteReorder = useCallback(
    async (favoriteIds: string[]) => {
      const previousData = favorites.data;
      const positions = new Map(favoriteIds.map((id, position) => [id, position]));
      setFavorites((prev) => ({
        ...prev,
        error: null,
        data: dedupeFavorites(
          prev.data.map((favorite) => ({
            ...favorite,
            position: positions.get(favorite.id) ?? favorite.position,
          })),
        ),
      }));
      try {
        const result = await reorderNavigationFavoritesAction({ favoriteIds });
        if (!result?.data) throw new Error("favorite_reorder_failed");
      } catch {
        setFavorites((prev) => ({
          ...prev,
          data: previousData,
          error: FAVORITES_UNAVAILABLE_MESSAGE,
        }));
      }
    },
    [favorites.data],
  );

  const handleTerminalFavoriteToggle = useCallback(
    async (workspaceId: string, sessionName: string, nextFavorited: boolean) => {
      const key = favoriteIdentity("terminal", workspaceId, sessionName);
      if (favorites.mutatingKeys.has(key)) return;

      setFavoriteMutating(key, true);
      try {
        if (nextFavorited) {
          const result = await upsertNavigationFavoriteAction({
            kind: "terminal",
            workspaceId,
            targetKey: sessionName,
            label: sessionName,
          });
          const favorite = result?.data;
          if (!isNavigationFavoriteDto(favorite)) throw new Error("favorite_upsert_failed");
          setFavorites((prev) => ({
            ...prev,
            data: dedupeFavorites([
              ...prev.data.filter(
                (currentFavorite) =>
                  favoriteIdentity(
                    currentFavorite.kind,
                    currentFavorite.workspaceId,
                    currentFavorite.targetKey,
                  ) !== key,
              ),
              favorite,
            ]),
            error: null,
          }));
        } else {
          const result = await removeNavigationFavoriteAction({
            kind: "terminal",
            workspaceId,
            targetKey: sessionName,
          });
          if (result?.data?.success !== true) throw new Error("favorite_remove_failed");
          setFavorites((prev) => ({
            ...prev,
            data: prev.data.filter(
              (favorite) =>
                favoriteIdentity(favorite.kind, favorite.workspaceId, favorite.targetKey) !== key,
            ),
            error: null,
          }));
        }
      } catch {
        setFavorites((prev) => ({ ...prev, error: FAVORITES_UNAVAILABLE_MESSAGE }));
      } finally {
        setFavoriteMutating(key, false);
      }
    },
    [favorites.mutatingKeys, setFavoriteMutating],
  );

  const handleGitFavoriteToggle = useCallback(
    async (workspaceId: string, repository: CloneTreeRepositoryNode, nextFavorited: boolean) => {
      const key = favoriteIdentity("git", workspaceId, repository.cloneSessionKey);
      if (favorites.mutatingKeys.has(key)) return;

      setFavoriteMutating(key, true);
      try {
        if (nextFavorited) {
          const result = await upsertNavigationFavoriteAction({
            kind: "git",
            workspaceId,
            targetKey: repository.cloneSessionKey,
            relativePath: repository.relativePath,
            label: repository.label,
          });
          const favorite = result?.data;
          if (!isNavigationFavoriteDto(favorite)) throw new Error("favorite_upsert_failed");
          setFavorites((prev) => ({
            ...prev,
            data: dedupeFavorites([
              ...prev.data.filter(
                (currentFavorite) =>
                  favoriteIdentity(
                    currentFavorite.kind,
                    currentFavorite.workspaceId,
                    currentFavorite.targetKey,
                  ) !== key,
              ),
              favorite,
            ]),
            error: null,
          }));
        } else {
          const result = await removeNavigationFavoriteAction({
            kind: "git",
            workspaceId,
            targetKey: repository.cloneSessionKey,
          });
          if (result?.data?.success !== true) throw new Error("favorite_remove_failed");
          setFavorites((prev) => ({
            ...prev,
            data: prev.data.filter(
              (favorite) =>
                favoriteIdentity(favorite.kind, favorite.workspaceId, favorite.targetKey) !== key,
            ),
            error: null,
          }));
        }
      } catch {
        setFavorites((prev) => ({ ...prev, error: FAVORITES_UNAVAILABLE_MESSAGE }));
      } finally {
        setFavoriteMutating(key, false);
      }
    },
    [favorites.mutatingKeys, setFavoriteMutating],
  );

  const handleCreateSession = useCallback(
    async (workspaceId: string) => {
      const result = await createSessionAction({ workspaceId });
      if (result?.data) {
        const name = result.data.name;
        if (isCloneTerminalSessionName(name)) {
          console.error("[sidebar] create session returned a reserved clone terminal session");
          return;
        }
        setWorkspaceSessions((prev) => {
          const current = prev[workspaceId] ?? { data: [], isLoading: false, error: null };
          const alreadyExists = current.data.some((s) => s.name === name);
          if (alreadyExists) return prev;
          return {
            ...prev,
            [workspaceId]: {
              ...current,
              data: [...current.data, { name, created: Date.now(), windows: 1 }],
            },
          };
        });
        navigateInternal(`/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(name)}`);
      } else {
        console.error("[sidebar] create session failed:", result?.serverError);
      }
    },
    [navigateInternal],
  );

  const handleKillSession = useCallback(
    async (workspaceId: string, sessionName: string) => {
      if (isCloneTerminalSessionName(sessionName)) {
        console.error("[sidebar] refused to kill a reserved clone terminal session");
        return;
      }
      const result = await killSessionAction({ workspaceId, sessionName });
      if (result?.data) {
        setWorkspaceSessions((prev) => {
          const current = prev[workspaceId];
          if (!current) return prev;
          return {
            ...prev,
            [workspaceId]: {
              ...current,
              data: current.data.filter((s) => s.name !== sessionName),
            },
          };
        });
        fetchSessions(workspaceId);
      } else {
        console.error("[sidebar] kill session failed:", result?.serverError);
      }
    },
    [fetchSessions],
  );

  const handleRenameSession = useCallback(
    async (workspaceId: string, oldName: string, newName: string) => {
      if (isCloneTerminalSessionName(oldName) || isCloneTerminalSessionName(newName)) {
        console.error("[sidebar] refused to rename a reserved clone terminal session");
        return;
      }
      const result = await renameSessionAction({ workspaceId, oldName, newName });
      if (result?.data) {
        const { newName: renamedTo } = result.data;
        setWorkspaceSessions((prev) => {
          const current = prev[workspaceId];
          if (!current) return prev;
          return {
            ...prev,
            [workspaceId]: {
              ...current,
              data: current.data.map((s) => (s.name === oldName ? { ...s, name: renamedTo } : s)),
            },
          };
        });
      } else {
        console.error("[sidebar] rename session failed:", result?.serverError);
      }
    },
    [],
  );

  const openGitCloneTerminal = useCallback(
    async (input: { workspaceId: string; cloneSessionKey: string; relativePath: string }) => {
      const { workspaceId, cloneSessionKey, relativePath } = input;
      setWorkspaceGitTerminalErrors((prev) => ({ ...prev, [workspaceId]: null }));

      try {
        const targetAgent =
          workspaceAgentsRef.current[workspaceId] ?? (await fetchAgentInfo(workspaceId));
        const result = await resolveGitCloneTerminalAction({
          cloneSessionKey,
          workspaceId,
          agentId: targetAgent?.agentId,
          relativePath,
        });
        const identity = result?.data;

        if (!isGitCloneTerminalIdentity(identity)) {
          console.warn("[sidebar] Git terminal open failed: action returned no terminal identity");
          setWorkspaceGitTerminalErrors((prev) => ({
            ...prev,
            [workspaceId]: GIT_TERMINAL_OPEN_ERROR_MESSAGE,
          }));
          setFavorites((prev) => ({ ...prev, error: GIT_TERMINAL_OPEN_ERROR_MESSAGE }));
          return;
        }

        const params = new URLSearchParams({
          session: identity.sessionName,
          clonePath: identity.clonePath,
          cloneProof: identity.cloneProof,
        });
        if (searchParams.get("debugViewport") === "1") {
          params.set("debugViewport", "1");
        }

        navigateInternal(
          `/workspaces/${encodeURIComponent(workspaceId)}/terminal?${params.toString()}`,
        );
      } catch {
        console.warn("[sidebar] Git terminal open failed: action rejected");
        setWorkspaceGitTerminalErrors((prev) => ({
          ...prev,
          [workspaceId]: GIT_TERMINAL_OPEN_ERROR_MESSAGE,
        }));
        setFavorites((prev) => ({ ...prev, error: GIT_TERMINAL_OPEN_ERROR_MESSAGE }));
      }
    },
    [fetchAgentInfo, navigateInternal, searchParams],
  );

  const handleGitRepositorySelect = useCallback(
    (workspaceId: string, repository: CloneTreeRepositoryNode) =>
      openGitCloneTerminal({
        workspaceId,
        cloneSessionKey: repository.cloneSessionKey,
        relativePath: repository.relativePath,
      }),
    [openGitCloneTerminal],
  );

  const handleGitFavoriteLaunch = useCallback(
    (favorite: NavigationFavoriteDto) => {
      if (favorite.kind !== "git" || !favorite.relativePath) return;
      openGitCloneTerminal({
        workspaceId: favorite.workspaceId,
        cloneSessionKey: favorite.targetKey,
        relativePath: favorite.relativePath,
      });
    },
    [openGitCloneTerminal],
  );

  return (
    <Sidebar variant={sidebarMode} collapsible="offcanvas">
      <SidebarHeader className="h-14 flex-row items-center justify-between border-b border-sidebar-border px-4">
        <Link href="/workspaces" className="flex items-center gap-2">
          <Hexagon className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold tracking-tight">Hive</span>
        </Link>
        <SidebarTrigger />
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Workspace navigation" className="flex flex-col gap-0">
          <FavoritesSection
            favorites={favorites}
            pathname={pathname}
            activeSession={activeSession}
            activeClonePath={activeClonePath}
            onGitFavoriteLaunch={handleGitFavoriteLaunch}
            onReorder={handleFavoriteReorder}
          />

          <SidebarGroup className="pb-0">
            <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
            <SidebarMenu>
              <Collapsible
                open={workspacesOpen}
                onOpenChange={setWorkspacesOpen}
                className="group/collapsible"
              >
                <SidebarMenuItem>
                  <div className="flex items-center gap-1">
                    <SidebarMenuButton
                      render={<Link href="/workspaces" />}
                      isActive={pathname === "/workspaces"}
                      aria-current={pathname === "/workspaces" ? "page" : undefined}
                      className="min-w-0 flex-1"
                    >
                      <Monitor className="h-4 w-4" />
                      <span>Workspaces</span>
                    </SidebarMenuButton>
                    <CollapsibleTrigger
                      render={<button type="button" />}
                      aria-label={`${workspacesOpen ? "Collapse" : "Expand"} workspace navigation`}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md outline-hidden max-md:size-11 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                      data-testid="workspaces-disclosure"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn("size-4 transition-transform", workspacesOpen && "rotate-90")}
                      />
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent id="workspace-navigation-tree">
                    {workspaces.error && (
                      <Alert variant="destructive" className="mx-4 my-1">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription className="flex items-center justify-between">
                          <span className="text-xs">{workspaces.error}</span>
                          <button
                            type="button"
                            onClick={fetchWorkspaces}
                            className="ml-2 text-xs underline"
                          >
                            Retry
                          </button>
                        </AlertDescription>
                      </Alert>
                    )}
                    {workspaces.isLoading && workspaces.data.length === 0 && (
                      <p className="px-6 py-2 text-xs text-muted-foreground">Loading...</p>
                    )}
                    <SidebarMenuSub className="!mr-0 !pr-0">
                      {workspaces.data.map((ws) => {
                        const agent = workspaceAgents[ws.id];
                        const urls =
                          agent && coderUrl
                            ? buildWorkspaceUrls(ws, agent.agentName, coderUrl)
                            : null;
                        const sessions = workspaceSessions[ws.id];
                        const agentUnavailable = agent && agent.agentStatus !== "connected";
                        const isRestarting = restartingWorkspaces.has(ws.id);
                        const gitState = workspaceGitDiscovery[ws.id] ?? {
                          result: null,
                          isLoading: false,
                          serverError: null,
                        };
                        const gitTerminalError = workspaceGitTerminalErrors[ws.id];
                        const isExpanded = expandedWorkspaces[ws.id] ?? false;
                        const isGitSectionExpanded = expandedGitSections[ws.id] ?? false;
                        const encodedWorkspaceId = encodeURIComponent(ws.id);
                        const multiSessionWorkspaceHref = `/workspaces/${encodedWorkspaceId}/terminal/workspace`;
                        const gitMultiSessionWorkspaceHref = `/workspaces/${encodedWorkspaceId}/terminal/git-workspace`;
                        const isWorkspacePageActive =
                          pathname === multiSessionWorkspaceHref ||
                          pathname === gitMultiSessionWorkspaceHref;
                        const isWorkspaceRouteActive = pathname.startsWith(
                          `/workspaces/${encodedWorkspaceId}/`,
                        );
                        return (
                          <Collapsible
                            key={ws.id}
                            open={isExpanded}
                            onOpenChange={(open) => handleWorkspaceExpand(ws.id, open)}
                          >
                            <SidebarMenuSubItem>
                              <div className="flex min-w-0 items-center gap-1">
                                <SidebarMenuSubButton
                                  render={<Link href={multiSessionWorkspaceHref} />}
                                  isActive={isWorkspaceRouteActive}
                                  aria-current={isWorkspacePageActive ? "page" : undefined}
                                  className="min-w-0 flex-1"
                                  data-testid={`workspace-link-${ws.id}`}
                                  title={ws.name}
                                >
                                  <Monitor aria-hidden="true" className="size-3 shrink-0" />
                                  <span className="truncate">{ws.name}</span>
                                  <Badge
                                    variant={
                                      ws.latest_build.status === "running" ? "default" : "secondary"
                                    }
                                    className="ml-auto px-1 py-0 text-[10px]"
                                  >
                                    {ws.latest_build.status}
                                  </Badge>
                                </SidebarMenuSubButton>
                                <CollapsibleTrigger
                                  render={<button type="button" />}
                                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${ws.name} navigation`}
                                  className="flex size-8 shrink-0 items-center justify-center rounded-md outline-hidden max-md:size-11 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                                  data-testid={`workspace-disclosure-${ws.id}`}
                                >
                                  <ChevronRight
                                    aria-hidden="true"
                                    className={cn(
                                      "size-4 transition-transform",
                                      isExpanded && "rotate-90",
                                    )}
                                  />
                                </CollapsibleTrigger>
                              </div>
                              <CollapsibleContent id={`workspace-navigation-${ws.id}`}>
                                <SidebarMenuSub className="!mr-0 !pr-0">
                                  <Collapsible
                                    open={expandedTerminals[ws.id] ?? false}
                                    onOpenChange={(open) =>
                                      setExpandedTerminals((prev) => ({ ...prev, [ws.id]: open }))
                                    }
                                    data-testid={`terminal-section-${ws.id}`}
                                  >
                                    <SidebarMenuSubItem>
                                      <SidebarMenuSubButton
                                        render={<CollapsibleTrigger />}
                                        className="min-h-8 w-full cursor-pointer"
                                      >
                                        <Terminal className="h-3 w-3 shrink-0" />
                                        <span>Sessions</span>
                                        <ChevronRight
                                          className={`ml-auto size-4 transition-transform ${expandedTerminals[ws.id] ? "rotate-90" : ""}`}
                                          data-testid={`terminal-section-chevron-${ws.id}`}
                                        />
                                      </SidebarMenuSubButton>
                                      <CollapsibleContent>
                                        {sessions?.error && (
                                          <Alert variant="destructive" className="mx-2 mb-1">
                                            <AlertCircle className="h-3 w-3" />
                                            <AlertDescription className="flex items-start justify-between gap-2">
                                              <span className="text-xs">{sessions.error}</span>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  agentUnavailable
                                                    ? handleRestartWorkspace(ws.id)
                                                    : fetchSessions(ws.id)
                                                }
                                                disabled={isRestarting}
                                                className="shrink-0 text-xs underline disabled:opacity-50"
                                              >
                                                {isRestarting
                                                  ? "Restarting…"
                                                  : agentUnavailable
                                                    ? "Restart workspace"
                                                    : "Retry"}
                                              </button>
                                            </AlertDescription>
                                          </Alert>
                                        )}
                                        {agentUnavailable && !sessions?.error && (
                                          <Alert variant="destructive" className="mx-2 mb-1">
                                            <AlertCircle className="h-3 w-3" />
                                            <AlertDescription className="space-y-1 text-xs">
                                              <p>
                                                Agent {agent.agentStatus}. Sessions are unavailable.
                                              </p>
                                              <button
                                                type="button"
                                                onClick={() => handleRestartWorkspace(ws.id)}
                                                disabled={isRestarting}
                                                className="underline disabled:opacity-50"
                                              >
                                                {isRestarting ? "Restarting…" : "Restart workspace"}
                                              </button>
                                            </AlertDescription>
                                          </Alert>
                                        )}
                                        <SidebarMenuSub className="!mr-0 !pr-0">
                                          <SidebarMenuSubItem>
                                            {!sessions || sessions.isLoading || agentUnavailable ? (
                                              <SidebarMenuSubButton
                                                className="cursor-not-allowed opacity-50"
                                                data-testid={`create-session-loading-${ws.id}`}
                                              >
                                                {sessions?.isLoading ? (
                                                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                                ) : (
                                                  <AlertCircle className="h-3 w-3 shrink-0" />
                                                )}
                                                <span>
                                                  {agentUnavailable
                                                    ? "Agent unavailable"
                                                    : "Loading…"}
                                                </span>
                                              </SidebarMenuSubButton>
                                            ) : (
                                              <SidebarMenuSubButton
                                                className="cursor-pointer"
                                                data-testid={`create-session-${ws.id}`}
                                                onClick={() => handleCreateSession(ws.id)}
                                              >
                                                <Plus className="h-3 w-3 shrink-0" />
                                                <span>Add session</span>
                                              </SidebarMenuSubButton>
                                            )}
                                          </SidebarMenuSubItem>
                                          <SessionList
                                            sessions={sessions?.data ?? []}
                                            workspaceId={ws.id}
                                            pathname={pathname}
                                            activeSession={activeSession}
                                            favoriteKeys={favoriteKeySet}
                                            mutatingFavoriteKeys={favorites.mutatingKeys}
                                            onFavoriteToggle={handleTerminalFavoriteToggle}
                                            onKill={handleKillSession}
                                            onRename={handleRenameSession}
                                          />
                                        </SidebarMenuSub>
                                      </CollapsibleContent>
                                    </SidebarMenuSubItem>
                                  </Collapsible>
                                  <Collapsible
                                    open={isGitSectionExpanded}
                                    onOpenChange={(open) => handleGitSectionExpand(ws.id, open)}
                                    data-testid={`git-section-${ws.id}`}
                                  >
                                    <SidebarMenuSubItem>
                                      <SidebarMenuSubButton
                                        render={<CollapsibleTrigger />}
                                        className="min-h-8 w-full cursor-pointer"
                                      >
                                        <GitBranch
                                          aria-hidden="true"
                                          className="h-3 w-3 shrink-0"
                                        />
                                        <span>Repositories</span>
                                        <ChevronRight
                                          aria-hidden="true"
                                          className={`ml-auto size-4 transition-transform ${isGitSectionExpanded ? "rotate-90" : ""}`}
                                          data-testid={`git-section-chevron-${ws.id}`}
                                        />
                                      </SidebarMenuSubButton>
                                      <CollapsibleContent>
                                        <GitDiscoveryPanel
                                          state={gitState}
                                          activeClonePath={
                                            pathname === `/workspaces/${ws.id}/terminal`
                                              ? activeClonePath
                                              : null
                                          }
                                          favoriteKeys={
                                            gitFavoriteKeysByWorkspace.get(ws.id) ?? new Set()
                                          }
                                          mutatingFavoriteKeys={
                                            mutatingGitFavoriteKeysByWorkspace.get(ws.id) ??
                                            new Set()
                                          }
                                          onFavoriteToggle={(repository, nextFavorited) =>
                                            handleGitFavoriteToggle(
                                              ws.id,
                                              repository,
                                              nextFavorited,
                                            )
                                          }
                                          onRetry={() => fetchGitClones(ws.id)}
                                          onRepositorySelect={(repository) =>
                                            handleGitRepositorySelect(ws.id, repository)
                                          }
                                        />
                                        {gitTerminalError && (
                                          <Alert
                                            variant="destructive"
                                            className="mx-2 mb-1"
                                            data-testid={`git-terminal-open-error-${ws.id}`}
                                          >
                                            <AlertCircle className="h-3 w-3" />
                                            <AlertDescription>
                                              <span className="text-xs">{gitTerminalError}</span>
                                            </AlertDescription>
                                          </Alert>
                                        )}
                                      </CollapsibleContent>
                                    </SidebarMenuSubItem>
                                  </Collapsible>
                                  {urls && (
                                    <SidebarMenuSubItem>
                                      <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/50">
                                        Tools
                                      </p>
                                      <SidebarMenuSub className="!mr-0 !pr-0">
                                        <SidebarMenuSubItem>
                                          <SidebarMenuSubButton
                                            render={
                                              <Link
                                                href={urls.filebrowser}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                              />
                                            }
                                            aria-label="Files (opens in a new tab)"
                                          >
                                            <FolderOpen
                                              aria-hidden="true"
                                              className="h-3 w-3 shrink-0"
                                            />
                                            <span>Files</span>
                                            <ExternalLink
                                              aria-hidden="true"
                                              className="ml-auto size-3"
                                            />
                                          </SidebarMenuSubButton>
                                        </SidebarMenuSubItem>
                                        <SidebarMenuSubItem>
                                          <SidebarMenuSubButton
                                            render={
                                              <Link
                                                href={urls.codeServer}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                              />
                                            }
                                            aria-label="VS Code (opens in a new tab)"
                                          >
                                            <Code aria-hidden="true" className="h-3 w-3 shrink-0" />
                                            <span>VS Code</span>
                                            <ExternalLink
                                              aria-hidden="true"
                                              className="ml-auto size-3"
                                            />
                                          </SidebarMenuSubButton>
                                        </SidebarMenuSubItem>
                                        <SidebarMenuSubItem>
                                          <SidebarMenuSubButton
                                            render={
                                              <Link
                                                href={urls.kasmvnc}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                              />
                                            }
                                            aria-label="Desktop (opens in a new tab)"
                                          >
                                            <ScreenIcon
                                              aria-hidden="true"
                                              className="h-3 w-3 shrink-0"
                                            />
                                            <span>Desktop</span>
                                            <ExternalLink
                                              aria-hidden="true"
                                              className="ml-auto size-3"
                                            />
                                          </SidebarMenuSubButton>
                                        </SidebarMenuSubItem>
                                      </SidebarMenuSub>
                                    </SidebarMenuSubItem>
                                  )}
                                </SidebarMenuSub>
                              </CollapsibleContent>
                            </SidebarMenuSubItem>
                          </Collapsible>
                        );
                      })}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="pt-0">
            <SidebarGroupLabel>Automation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1" data-testid="automation-menu">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href="/tasks" />}
                    isActive={
                      pathname === "/tasks" ||
                      (pathname.startsWith("/tasks/") && !pathname.startsWith("/tasks/new"))
                    }
                    aria-current={
                      pathname === "/tasks" ||
                      (pathname.startsWith("/tasks/") && !pathname.startsWith("/tasks/new"))
                        ? "page"
                        : undefined
                    }
                  >
                    <ListTodo aria-hidden="true" className="h-4 w-4" />
                    <span>Tasks</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href="/tasks/new" />}
                    isActive={pathname === "/tasks/new"}
                    aria-current={pathname === "/tasks/new" ? "page" : undefined}
                  >
                    <PlusCircle aria-hidden="true" className="h-4 w-4" />
                    <span>New Task</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="pt-0">
            <SidebarGroupLabel>Administration</SidebarGroupLabel>
            <SidebarMenu>
              <Collapsible
                open={templatesOpen}
                onOpenChange={setTemplatesOpen}
                className="group/collapsible-templates"
              >
                <SidebarMenuItem>
                  <div className="flex items-center gap-1">
                    <SidebarMenuButton
                      render={<Link href="/templates" />}
                      isActive={pathname === "/templates"}
                      aria-current={pathname === "/templates" ? "page" : undefined}
                      className="min-w-0 flex-1"
                    >
                      <LayoutTemplate className="h-4 w-4" />
                      <span>Templates</span>
                    </SidebarMenuButton>
                    <CollapsibleTrigger
                      render={<button type="button" />}
                      aria-label={`${templatesOpen ? "Collapse" : "Expand"} template navigation`}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md outline-hidden max-md:size-11 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                      data-testid="templates-disclosure"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn("size-4 transition-transform", templatesOpen && "rotate-90")}
                      />
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent id="template-navigation-tree">
                    {templates.error && (
                      <Alert variant="destructive" className="mx-4 my-1">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription className="flex items-center justify-between">
                          <span className="text-xs">{templates.error}</span>
                          <button
                            type="button"
                            onClick={fetchTemplates}
                            className="ml-2 text-xs underline"
                          >
                            Retry
                          </button>
                        </AlertDescription>
                      </Alert>
                    )}
                    {templates.isLoading && templates.data.length === 0 && (
                      <p className="px-6 py-2 text-xs text-muted-foreground">Loading...</p>
                    )}
                    <SidebarMenuSub className="!mr-0 !pr-0">
                      {templates.data.map((tpl) => (
                        <SidebarMenuSubItem key={tpl.name}>
                          <SidebarMenuSubButton
                            render={<Link href={`/templates/${tpl.name}`} />}
                            isActive={pathname === `/templates/${tpl.name}`}
                          >
                            <span className="truncate">{tpl.name}</span>
                            <Badge
                              variant={tpl.stale ? "destructive" : "secondary"}
                              className="ml-auto text-[10px] px-1 py-0"
                            >
                              {tpl.stale ? "stale" : "fresh"}
                            </Badge>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="pt-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/terminal/status" />}
                  isActive={pathname === "/terminal/status"}
                  aria-current={pathname === "/terminal/status" ? "page" : undefined}
                >
                  <Stethoscope className="h-4 w-4" />
                  <span>Diagnostics</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          {coderUrl && (
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link href={coderUrl} target="_blank" rel="noopener noreferrer" />}
                aria-label="Open Coder (opens in a new tab)"
              >
                <LayoutDashboard aria-hidden="true" className="h-4 w-4" />
                <span>Open Coder</span>
                <ExternalLink aria-hidden="true" className="ml-auto size-3" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
            <SidebarMenuItem>
              <SidebarMenuButton render={<CollapsibleTrigger />}>
                <Settings className="h-4 w-4" />
                <span>Settings</span>
                <ChevronRight
                  className={`ml-auto h-4 w-4 transition-transform ${settingsOpen ? "rotate-90" : ""}`}
                />
              </SidebarMenuButton>
              <CollapsibleContent>
                <div className="space-y-3 px-3 py-2">
                  <Field
                    orientation="horizontal"
                    className="min-h-11 items-center justify-between rounded-md px-1 py-1"
                    data-testid="terminal-controls-beyond-mobile-setting"
                    data-disabled={isTerminalSettingsLoading || isTerminalSettingsUpdating}
                    data-invalid={Boolean(terminalSettingsError)}
                  >
                    <FieldContent className="pr-2">
                      <FieldLabel
                        id={TERMINAL_CONTROLS_SWITCH_LABEL_ID}
                        htmlFor={TERMINAL_CONTROLS_SWITCH_ID}
                        className="text-xs font-medium"
                      >
                        Show terminal controls beyond phone
                      </FieldLabel>
                      <FieldDescription
                        id={TERMINAL_CONTROLS_SWITCH_DESCRIPTION_ID}
                        className="text-[10px] leading-snug"
                      >
                        Use mobile-style terminal controls on tablet, laptop, and desktop.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id={TERMINAL_CONTROLS_SWITCH_ID}
                      data-testid="terminal-controls-beyond-mobile-switch"
                      checked={terminalControlsBeyondMobile}
                      disabled={isTerminalSettingsLoading || isTerminalSettingsUpdating}
                      aria-labelledby={TERMINAL_CONTROLS_SWITCH_LABEL_ID}
                      aria-describedby={
                        terminalSettingsError
                          ? TERMINAL_CONTROLS_SWITCH_ERROR_ID
                          : TERMINAL_CONTROLS_SWITCH_DESCRIPTION_ID
                      }
                      aria-invalid={Boolean(terminalSettingsError)}
                      onCheckedChange={handleTerminalControlsBeyondMobileChange}
                    />
                  </Field>
                  {isTerminalSettingsLoading && (
                    <p className="text-[10px] text-muted-foreground" role="status">
                      Loading terminal controls setting…
                    </p>
                  )}
                  {terminalSettingsError && (
                    <div
                      id={TERMINAL_CONTROLS_SWITCH_ERROR_ID}
                      className="flex items-center justify-between gap-2 text-[10px] text-destructive"
                      role="alert"
                      data-testid="terminal-settings-error"
                    >
                      <span>{terminalSettingsError}</span>
                      <button
                        type="button"
                        onClick={loadTerminalSettings}
                        disabled={isTerminalSettingsLoading || isTerminalSettingsUpdating}
                        className="min-h-11 rounded px-2 text-[10px] underline disabled:opacity-50"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs text-muted-foreground">Refresh</span>
                      <p
                        className="text-[10px] text-muted-foreground/60"
                        data-testid="last-refreshed"
                      >
                        {relativeTime}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchAll}
                      className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                      title="Refresh"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="rounded-md border border-sidebar-border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="text-xs text-muted-foreground">App update</span>
                        <p className="text-[10px] leading-snug text-muted-foreground/60">
                          Clear installed app caches and reload the newest build.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void refreshInstalledApp()}
                        className="min-h-9 shrink-0 rounded border border-sidebar-border px-2 text-[10px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                        data-testid="update-installed-app"
                      >
                        Update
                      </button>
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        </SidebarMenu>
        {sessionUser && (
          <DropdownMenu>
            <DropdownMenuTrigger className="w-full rounded-md p-2 text-left hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-center gap-2 min-w-0">
                <Avatar size="sm">
                  <AvatarFallback>{sessionUser.email.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">{sessionUser.email}</span>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal">
                  <p className="truncate text-xs text-muted-foreground">{sessionUser.coderUrl}</p>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isLoggingOut}
                onClick={async () => {
                  setIsLoggingOut(true);
                  try {
                    await fetch("/api/auth/logout", { method: "POST" });
                  } finally {
                    router.push("/login");
                    router.refresh();
                  }
                }}
              >
                {isLoggingOut ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" />
                )}
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
