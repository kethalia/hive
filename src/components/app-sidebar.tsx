"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ListTodo,
  PlusCircle,
  Settings,
  Hexagon,
  LayoutTemplate,
  Monitor,
  LayoutDashboard,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  AlertCircle,
  Terminal,
  Plus,
  X,
  Pencil,
  FolderOpen,
  Monitor as ScreenIcon,
  Code,
  Loader2,
  LogOut,
} from "lucide-react";
import { useSidebarMode } from "@/hooks/use-sidebar-mode";
import {
  listWorkspacesAction,
  getWorkspaceAgentAction,
  getWorkspaceSessionsAction,
  createSessionAction,
  killSessionAction,
  renameSessionAction,
} from "@/lib/actions/workspaces";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";
import { listTemplateStatusesAction } from "@/lib/actions/templates";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { TmuxSession } from "@/lib/workspaces/sessions";
import type { TemplateStatus } from "@/lib/templates/staleness";
import { getSessionAction, logoutAction } from "@/lib/auth/actions";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";

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

function openPopup(url: string, title: string) {
  window.open(url, title, "width=1200,height=800,menubar=no,toolbar=no");
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

interface AgentInfo {
  agentId: string;
  agentName: string;
}

const SESSION_MAX_HEIGHT = 160;

function SessionList({
  sessions,
  workspaceId,
  pathname,
  activeSession,
  onKill,
  onRename,
}: {
  sessions: TmuxSession[];
  workspaceId: string;
  pathname: string;
  activeSession: string | null;
  onKill: (workspaceId: string, sessionName: string) => void;
  onRename: (workspaceId: string, oldName: string, newName: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasOverflow = el.scrollHeight > el.clientHeight;
    setCanScroll(hasOverflow);
    setIsAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
  }, []);

  useEffect(() => {
    checkScroll();
  }, [sessions.length, checkScroll]);

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
        className="overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ maxHeight: SESSION_MAX_HEIGHT }}
        onScroll={checkScroll}
      >
        {sessions.map((session) => (
          <SidebarMenuSubItem key={session.name}>
            {editingSession === session.name ? (
              <SidebarMenuSubButton className="cursor-text">
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
              <SidebarMenuSubButton
                render={<Link href={`/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(session.name)}`} />}
                isActive={pathname === `/workspaces/${workspaceId}/terminal` && activeSession === session.name}
                className="group/session"
              >
                <Terminal className="h-3 w-3 shrink-0" />
                <span className="truncate">{session.name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover/session:opacity-100">
                  <button
                    type="button"
                    title="Rename session"
                    data-testid={`rename-session-${session.name}`}
                    className="rounded p-0.5 hover:bg-sidebar-accent"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); startRename(session.name); }}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Kill session"
                    data-testid={`kill-session-${session.name}`}
                    className="rounded p-0.5 hover:bg-destructive/20"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onKill(workspaceId, session.name); }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </SidebarMenuSubButton>
            )}
          </SidebarMenuSubItem>
        ))}
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

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSession = searchParams.get("session");
  const [sidebarMode, setSidebarMode] = useSidebarMode();
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const coderUrl = sessionUser?.coderUrl ?? undefined;

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
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const relativeTime = useRelativeTime(lastRefreshed, settingsOpen);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [expandedTerminals, setExpandedTerminals] = useState<Record<string, boolean>>({});
  const [workspaceAgents, setWorkspaceAgents] = useState<Record<string, AgentInfo | null>>({});
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, WorkspaceSessionState>>({});

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIntervalRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

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

  const fetchAgentInfo = useCallback(async (workspaceId: string) => {
    try {
      const result = await getWorkspaceAgentAction({ workspaceId });
      if (result?.data) {
        setWorkspaceAgents((prev) => ({ ...prev, [workspaceId]: result.data! }));
        return result.data;
      }
    } catch {
      // fall through to null
    }
    setWorkspaceAgents((prev) => ({ ...prev, [workspaceId]: null }));
    return null;
  }, []);

  const fetchSessions = useCallback(async (workspaceId: string) => {
    setWorkspaceSessions((prev) => ({
      ...prev,
      [workspaceId]: { ...(prev[workspaceId] ?? { data: [] }), isLoading: true, error: null },
    }));
    try {
      const result = await getWorkspaceSessionsAction({ workspaceId });
      if (result?.data) {
        setWorkspaceSessions((prev) => ({
          ...prev,
          [workspaceId]: { data: result.data!, isLoading: false, error: null },
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
    }
  }, []);

  const expandedWorkspacesRef = useRef(expandedWorkspaces);
  expandedWorkspacesRef.current = expandedWorkspaces;

  const fetchAll = useCallback(() => {
    fetchWorkspaces();
    fetchTemplates();
  }, [fetchWorkspaces, fetchTemplates]);

  useEffect(() => {
    fetchAll();
    intervalRef.current = setInterval(fetchAll, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchAll]);

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

  const handleWorkspaceExpand = useCallback((workspaceId: string, open: boolean) => {
    setExpandedWorkspaces((prev) => ({ ...prev, [workspaceId]: open }));
    if (open) {
      if (!workspaceAgentsRef.current[workspaceId]) {
        fetchAgentInfo(workspaceId);
      }
      fetchSessions(workspaceId);
    }
  }, [fetchAgentInfo, fetchSessions]);

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

  const handleCreateSession = useCallback(async (workspaceId: string) => {
    const result = await createSessionAction({ workspaceId });
    if (result?.data) {
      const name = result.data.name;
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
      router.push(`/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(name)}`);
    } else {
      console.error("[sidebar] create session failed:", result?.serverError);
    }
  }, [router]);

  const handleKillSession = useCallback(async (workspaceId: string, sessionName: string) => {
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
  }, [fetchSessions]);

  const handleRenameSession = useCallback(async (workspaceId: string, oldName: string, newName: string) => {
    const result = await renameSessionAction({ workspaceId, oldName, newName });
    if (result?.data) {
      setWorkspaceSessions((prev) => {
        const current = prev[workspaceId];
        if (!current) return prev;
        return {
          ...prev,
          [workspaceId]: {
            ...current,
            data: current.data.map((s) =>
              s.name === oldName ? { ...s, name: result.data!.newName } : s,
            ),
          },
        };
      });
    } else {
      console.error("[sidebar] rename session failed:", result?.serverError);
    }
  }, []);

  return (
    <Sidebar variant={sidebarMode} collapsible="offcanvas">
      <SidebarHeader className="h-14 flex-row items-center justify-between border-b border-sidebar-border px-4">
        <Link href="/tasks" className="flex items-center gap-2">
          <Hexagon className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold tracking-tight">Hive</span>
        </Link>
        <SidebarTrigger />
      </SidebarHeader>

      <SidebarContent>
        {/* Navigation */}
        <SidebarGroup className="pb-0">
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/tasks" />}
                  isActive={pathname === "/tasks" || (pathname.startsWith("/tasks/") && !pathname.startsWith("/tasks/new"))}
                >
                  <ListTodo className="h-4 w-4" />
                  <span>Tasks</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/tasks/new" />}
                  isActive={pathname === "/tasks/new"}
                >
                  <PlusCircle className="h-4 w-4" />
                  <span>New Task</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {coderUrl && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={
                      <a
                        href={coderUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                  >
                    <LayoutDashboard className="h-4 w-4" />
                    <span>Dashboard</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Workspaces */}
        <SidebarGroup className="py-0">
          <SidebarMenu>
            <Collapsible defaultOpen={workspacesOpen} onOpenChange={setWorkspacesOpen} className="group/collapsible">
              <SidebarMenuItem>
                <SidebarMenuButton render={<CollapsibleTrigger />}>
                  <Monitor className="h-4 w-4" />
                  <span>Workspaces</span>
                  <ChevronRight
                    className="ml-auto h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-90"
                  />
                </SidebarMenuButton>
                <CollapsibleContent>
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
                      const urls = agent && coderUrl ? buildWorkspaceUrls(ws, agent.agentName, coderUrl) : null;
                      const sessions = workspaceSessions[ws.id];
                      const isExpanded = expandedWorkspaces[ws.id] ?? false;
                      return (
                        <Collapsible
                          key={ws.id}
                          open={isExpanded}
                          onOpenChange={(open) => handleWorkspaceExpand(ws.id, open)}
                        >
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton
                              render={<CollapsibleTrigger />}
                              className="w-full cursor-pointer"
                            >
                              <ChevronRight
                                className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                              />
                              <span className="truncate">{ws.name}</span>
                              <Badge
                                variant={ws.latest_build.status === "running" ? "default" : "secondary"}
                                className="ml-auto text-[10px] px-1 py-0"
                              >
                                {ws.latest_build.status}
                              </Badge>
                            </SidebarMenuSubButton>
                            <CollapsibleContent>
                              <SidebarMenuSub className="!mr-0 !pr-0">
                                {urls && (
                                  <>
                                    <SidebarMenuSubItem>
                                      <SidebarMenuSubButton
                                        className="cursor-pointer"
                                        onClick={() => openPopup(urls.filebrowser, "Filebrowser")}
                                      >
                                        <FolderOpen className="h-3 w-3 shrink-0" />
                                        <span>Filebrowser</span>
                                      </SidebarMenuSubButton>
                                    </SidebarMenuSubItem>
                                    <SidebarMenuSubItem>
                                      <SidebarMenuSubButton
                                        className="cursor-pointer"
                                        onClick={() => openPopup(urls.kasmvnc, "KasmVNC")}
                                      >
                                        <ScreenIcon className="h-3 w-3 shrink-0" />
                                        <span>KasmVNC</span>
                                      </SidebarMenuSubButton>
                                    </SidebarMenuSubItem>
                                    <SidebarMenuSubItem>
                                      <SidebarMenuSubButton
                                        className="cursor-pointer"
                                        onClick={() => openPopup(urls.codeServer, "Code Server")}
                                      >
                                        <Code className="h-3 w-3 shrink-0" />
                                        <span>Code Server</span>
                                      </SidebarMenuSubButton>
                                    </SidebarMenuSubItem>
                                  </>
                                )}
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
                                      className="w-full cursor-pointer"
                                    >
                                      <Terminal className="h-3 w-3 shrink-0" />
                                      <span>Terminal</span>
                                      <ChevronRight
                                        className={`ml-auto h-3 w-3 transition-transform ${expandedTerminals[ws.id] ? "rotate-90" : ""}`}
                                      />
                                    </SidebarMenuSubButton>
                                    <CollapsibleContent>
                                      {sessions?.error && (
                                        <Alert variant="destructive" className="mx-2 mb-1">
                                          <AlertCircle className="h-3 w-3" />
                                          <AlertDescription className="flex items-center justify-between">
                                            <span className="text-xs">{sessions.error}</span>
                                            <button
                                              type="button"
                                              onClick={() => fetchSessions(ws.id)}
                                              className="ml-2 text-xs underline"
                                            >
                                              Retry
                                            </button>
                                          </AlertDescription>
                                        </Alert>
                                      )}
                                      <SidebarMenuSub className="!mr-0 !pr-0">
                                        <SidebarMenuSubItem>
                                          {(!sessions || sessions.isLoading) ? (
                                          <SidebarMenuSubButton
                                            className="cursor-not-allowed opacity-50"
                                            data-testid={`create-session-loading-${ws.id}`}
                                          >
                                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                            <span>Loading…</span>
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
                                          onKill={handleKillSession}
                                          onRename={handleRenameSession}
                                        />
                                      </SidebarMenuSub>
                                    </CollapsibleContent>
                                  </SidebarMenuSubItem>
                                </Collapsible>
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

        {/* Templates */}
        <SidebarGroup className="pt-0">
          <SidebarMenu>
            <Collapsible defaultOpen={templatesOpen} onOpenChange={setTemplatesOpen} className="group/collapsible-templates">
              <SidebarMenuItem>
                <SidebarMenuButton render={<CollapsibleTrigger />}>
                  <LayoutTemplate className="h-4 w-4" />
                  <span>Templates</span>
                  <ChevronRight
                    className="ml-auto h-4 w-4 transition-transform group-data-[state=open]/collapsible-templates:rotate-90"
                  />
                </SidebarMenuButton>
                <CollapsibleContent>
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
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
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
                  <div className="flex items-center justify-between">
                    <label htmlFor="sidebar-float-switch" className="text-xs text-muted-foreground">
                      Float sidebar
                    </label>
                    <Switch
                      id="sidebar-float-switch"
                      size="sm"
                      checked={sidebarMode === "floating"}
                      onCheckedChange={(checked) => setSidebarMode(checked)}
                      data-testid="sidebar-mode-toggle"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs text-muted-foreground">Refresh</span>
                      <p className="text-[10px] text-muted-foreground/60" data-testid="last-refreshed">
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
                  <AvatarFallback>
                    {sessionUser.email.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">{sessionUser.email}</span>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal">
                  <p className="truncate text-xs text-muted-foreground">
                    {sessionUser.coderUrl}
                  </p>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isLoggingOut}
                onClick={async () => {
                  setIsLoggingOut(true);
                  await logoutAction();
                  router.push("/login");
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
