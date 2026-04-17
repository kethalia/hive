"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  ListTodo,
  PlusCircle,
  Settings,
  Hexagon,
  LayoutTemplate,
  Monitor,
  LayoutDashboard,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  Terminal,
  Plus,
  X,
  FolderOpen,
  Monitor as ScreenIcon,
  Code,
  ExternalLink,
  Pin,
  PinOff,
} from "lucide-react";
import { useSidebarMode } from "@/hooks/use-sidebar-mode";
import {
  listWorkspacesAction,
  getWorkspaceAgentAction,
  getWorkspaceSessionsAction,
  createSessionAction,
  killSessionAction,
} from "@/lib/actions/workspaces";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";
import { listTemplateStatusesAction } from "@/lib/actions/templates";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { TmuxSession } from "@/lib/workspaces/sessions";
import type { TemplateStatus } from "@/lib/templates/staleness";

const POLL_INTERVAL_MS = 30_000;

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

export function AppSidebar({ coderUrl }: { coderUrl?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarMode, toggleSidebarMode] = useSidebarMode();

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

  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [workspaceAgents, setWorkspaceAgents] = useState<Record<string, AgentInfo | null>>({});
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, WorkspaceSessionState>>({});

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIntervalRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const fetchWorkspaces = useCallback(async () => {
    setWorkspaces((prev) => ({ ...prev, isLoading: true, error: null }));
    const result = await listWorkspacesAction();
    if (result?.data) {
      setWorkspaces({ data: result.data, isLoading: false, error: null });
      setLastRefreshed(new Date());
    } else {
      const msg =
        result?.serverError ?? "Failed to fetch workspaces";
      console.error("[sidebar] workspace fetch error:", msg);
      setWorkspaces((prev) => ({ ...prev, isLoading: false, error: msg }));
    }
  }, []);

  const fetchTemplates = useCallback(async () => {
    setTemplates((prev) => ({ ...prev, isLoading: true, error: null }));
    const result = await listTemplateStatusesAction();
    if (result?.data) {
      setTemplates({ data: result.data, isLoading: false, error: null });
      setLastRefreshed(new Date());
    } else {
      const msg =
        result?.serverError ?? "Failed to fetch templates";
      console.error("[sidebar] template fetch error:", msg);
      setTemplates((prev) => ({ ...prev, isLoading: false, error: msg }));
    }
  }, []);

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

  useEffect(() => {
    const handleSidebarRefresh = () => {
      console.log("[workspaces] Received hive:sidebar-refresh, re-fetching all data");
      fetchAll();
    };
    window.addEventListener("hive:sidebar-refresh", handleSidebarRefresh);
    return () => {
      window.removeEventListener("hive:sidebar-refresh", handleSidebarRefresh);
    };
  }, [fetchAll]);

  const fetchAgentInfo = useCallback(async (workspaceId: string) => {
    const result = await getWorkspaceAgentAction({ workspaceId });
    if (result?.data) {
      console.log(`[workspaces] Fetched agent info for workspace ${workspaceId}:`, result.data);
      setWorkspaceAgents((prev) => ({ ...prev, [workspaceId]: result.data! }));
      return result.data;
    }
    console.error(`[workspaces] Failed to fetch agent for workspace ${workspaceId}`);
    setWorkspaceAgents((prev) => ({ ...prev, [workspaceId]: null }));
    return null;
  }, []);

  const fetchSessions = useCallback(async (workspaceId: string) => {
    setWorkspaceSessions((prev) => ({
      ...prev,
      [workspaceId]: { ...(prev[workspaceId] ?? { data: [] }), isLoading: true, error: null },
    }));
    const result = await getWorkspaceSessionsAction({ workspaceId });
    if (result?.data) {
      console.log(`[workspaces] Fetched ${result.data.length} sessions for workspace ${workspaceId}`);
      setWorkspaceSessions((prev) => ({
        ...prev,
        [workspaceId]: { data: result.data!, isLoading: false, error: null },
      }));
    } else {
      const msg = result?.serverError ?? "Failed to load sessions";
      console.error(`[workspaces] Session fetch error for ${workspaceId}:`, msg);
      setWorkspaceSessions((prev) => ({
        ...prev,
        [workspaceId]: { ...(prev[workspaceId] ?? { data: [] }), isLoading: false, error: msg },
      }));
    }
  }, []);

  const handleWorkspaceExpand = useCallback((workspaceId: string, open: boolean) => {
    setExpandedWorkspaces((prev) => ({ ...prev, [workspaceId]: open }));
    if (open) {
      if (!(workspaceId in workspaceAgents)) {
        fetchAgentInfo(workspaceId);
      }
      fetchSessions(workspaceId);
    }
  }, [workspaceAgents, fetchAgentInfo, fetchSessions]);

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
      console.log(`[workspaces] Created session "${result.data.name}" for workspace ${workspaceId}`);
      router.push(`/workspaces/${workspaceId}/terminal?session=${result.data.name}`);
      fetchSessions(workspaceId);
    } else {
      const msg = result?.serverError ?? "Failed to create session";
      console.error(`[workspaces] Create session error for ${workspaceId}:`, msg);
    }
  }, [router, fetchSessions]);

  const handleKillSession = useCallback(async (workspaceId: string, sessionName: string) => {
    const result = await killSessionAction({ workspaceId, sessionName });
    if (result?.data) {
      console.log(`[workspaces] Killed session "${sessionName}" in workspace ${workspaceId}`);
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
      const msg = result?.serverError ?? "Failed to kill session";
      console.error(`[workspaces] Kill session error for ${workspaceId}/${sessionName}:`, msg);
    }
  }, [fetchSessions]);

  return (
    <Sidebar collapsible={sidebarMode}>
      <SidebarHeader className="h-14 flex-row items-center border-b border-sidebar-border px-4">
        <Link href="/tasks" className="flex items-center gap-2">
          <Hexagon className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold tracking-tight">Hive</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {/* Navigation */}
        <SidebarGroup>
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
        <Collapsible defaultOpen={workspacesOpen} onOpenChange={setWorkspacesOpen}>
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center gap-1">
              <CollapsibleTrigger className="flex items-center gap-1">
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${workspacesOpen ? "rotate-90" : ""}`}
                />
                <Monitor className="h-3.5 w-3.5" />
                <span>Workspaces</span>
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                {workspaces.error && (
                  <Alert variant="destructive" className="mx-2 mb-2">
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
                  <p className="px-4 py-2 text-xs text-muted-foreground">Loading...</p>
                )}
                <SidebarMenu>
                  <SidebarMenuSub>
                    {workspaces.data.map((ws) => {
                      const agent = workspaceAgents[ws.id];
                      const urls = agent && coderUrl ? buildWorkspaceUrls(ws, agent.agentName, coderUrl) : null;
                      const sessions = workspaceSessions[ws.id];
                      return (
                        <SidebarMenuSubItem key={ws.id}>
                          <Collapsible
                            open={expandedWorkspaces[ws.id] ?? false}
                            onOpenChange={(open) => handleWorkspaceExpand(ws.id, open)}
                          >
                            <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-sidebar-accent">
                              <ChevronRight
                                className={`h-3 w-3 shrink-0 transition-transform ${expandedWorkspaces[ws.id] ? "rotate-90" : ""}`}
                              />
                              <span className="truncate">{ws.name}</span>
                              <Badge
                                variant={ws.latest_build.status === "running" ? "default" : "secondary"}
                                className="ml-auto text-[10px] px-1 py-0"
                              >
                                {ws.latest_build.status}
                              </Badge>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              {/* External links */}
                              {urls && (
                                <div className="flex items-center gap-1 px-6 py-1" data-testid={`external-links-${ws.id}`}>
                                  <a href={urls.filebrowser} target="_blank" rel="noopener noreferrer" title="Filebrowser" className="rounded p-1 hover:bg-sidebar-accent">
                                    <FolderOpen className="h-3.5 w-3.5" />
                                  </a>
                                  <a href={urls.kasmvnc} target="_blank" rel="noopener noreferrer" title="KasmVNC" className="rounded p-1 hover:bg-sidebar-accent">
                                    <ScreenIcon className="h-3.5 w-3.5" />
                                  </a>
                                  <a href={urls.codeServer} target="_blank" rel="noopener noreferrer" title="Code Server" className="rounded p-1 hover:bg-sidebar-accent">
                                    <Code className="h-3.5 w-3.5" />
                                  </a>
                                </div>
                              )}
                              {/* Session error */}
                              {sessions?.error && (
                                <Alert variant="destructive" className="mx-4 mb-1">
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
                              {/* Session loading */}
                              {sessions?.isLoading && (!sessions.data || sessions.data.length === 0) && (
                                <p className="px-6 py-1 text-xs text-muted-foreground">Loading sessions...</p>
                              )}
                              {/* Session list */}
                              <SidebarMenuSub>
                                {sessions?.data?.map((session) => (
                                  <SidebarMenuSubItem key={session.name}>
                                    <div className="flex items-center">
                                      <SidebarMenuSubButton
                                        render={<Link href={`/workspaces/${ws.id}/terminal?session=${session.name}`} />}
                                        isActive={pathname === `/workspaces/${ws.id}/terminal` && pathname.includes(session.name)}
                                        className="flex-1"
                                      >
                                        <Terminal className="h-3 w-3 shrink-0" />
                                        <span className="truncate">{session.name}</span>
                                      </SidebarMenuSubButton>
                                      <button
                                        type="button"
                                        title="Kill session"
                                        data-testid={`kill-session-${session.name}`}
                                        className="rounded p-0.5 hover:bg-destructive/20"
                                        onClick={() => handleKillSession(ws.id, session.name)}
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </SidebarMenuSubItem>
                                ))}
                                <SidebarMenuSubItem>
                                  <button
                                    type="button"
                                    title="New session"
                                    data-testid={`create-session-${ws.id}`}
                                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                                    onClick={() => handleCreateSession(ws.id)}
                                  >
                                    <Plus className="h-3 w-3" />
                                    <span>New session</span>
                                  </button>
                                </SidebarMenuSubItem>
                              </SidebarMenuSub>
                            </CollapsibleContent>
                          </Collapsible>
                        </SidebarMenuSubItem>
                      );
                    })}
                  </SidebarMenuSub>
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>

        {/* Templates */}
        <Collapsible defaultOpen={templatesOpen} onOpenChange={setTemplatesOpen}>
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center gap-1">
              <CollapsibleTrigger className="flex items-center gap-1">
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${templatesOpen ? "rotate-90" : ""}`}
                />
                <LayoutTemplate className="h-3.5 w-3.5" />
                <span>Templates</span>
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                {templates.error && (
                  <Alert variant="destructive" className="mx-2 mb-2">
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
                  <p className="px-4 py-2 text-xs text-muted-foreground">Loading...</p>
                )}
                <SidebarMenu>
                  <SidebarMenuSub>
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
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[10px] text-muted-foreground">
            {lastRefreshed
              ? `Updated ${lastRefreshed.toLocaleTimeString()}`
              : "Loading..."}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggleSidebarMode}
              className="text-muted-foreground hover:text-foreground"
              title={sidebarMode === "offcanvas" ? "Collapse to icons" : "Expand sidebar"}
              data-testid="sidebar-mode-toggle"
            >
              {sidebarMode === "offcanvas" ? (
                <PinOff className="h-3 w-3" />
              ) : (
                <Pin className="h-3 w-3" />
              )}
            </button>
            <button
              type="button"
              onClick={fetchAll}
              className="text-muted-foreground hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
