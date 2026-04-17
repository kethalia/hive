"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "lucide-react";
import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { listTemplateStatusesAction } from "@/lib/actions/templates";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { TemplateStatus } from "@/lib/templates/staleness";

const POLL_INTERVAL_MS = 30_000;

interface SectionState<T> {
  data: T[];
  isLoading: boolean;
  error: string | null;
}

export function AppSidebar({ coderUrl }: { coderUrl?: string }) {
  const pathname = usePathname();

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

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  return (
    <Sidebar>
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
                    {workspaces.data.map((ws) => (
                      <SidebarMenuSubItem key={ws.id}>
                        <SidebarMenuSubButton
                          render={<Link href={`/workspaces/${ws.id}`} />}
                          isActive={pathname === `/workspaces/${ws.id}`}
                        >
                          <span className="truncate">{ws.name}</span>
                          <Badge
                            variant={ws.latest_build.status === "running" ? "default" : "secondary"}
                            className="ml-auto text-[10px] px-1 py-0"
                          >
                            {ws.latest_build.status}
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
          <button
            type="button"
            onClick={fetchAll}
            className="text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
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
