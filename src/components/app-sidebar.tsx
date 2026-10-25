"use client";

import {
  AlertCircle,
  ChevronRight,
  Code,
  ExternalLink,
  FolderOpen,
  LayoutDashboard,
  LayoutTemplate,
  Loader2,
  LogOut,
  Monitor,
  Settings,
  Stethoscope,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { HiveLogo } from "@/components/hive-logo";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { WorkspaceSidebarButton } from "@/components/workspaces/WorkspaceHeaderButton";
import { getSessionAction } from "@/lib/auth/actions";
import type { CoderWorkspace } from "@/lib/coder/types";
import { useDiscovery } from "@/lib/discovery/queries";
import { workspaceTemplateCapabilities, workspaceTemplatePurpose } from "@/lib/templates/catalog";
import { cn } from "@/lib/utils";
import {
  GENERAL_WORKSPACE_OPEN_EVENT,
  type GeneralWorkspaceTool,
  generalWorkspaceHref,
} from "@/lib/workspaces/general-workspace";

function WorkspaceNavigationItem({
  workspace,
  pathname,
}: {
  workspace: CoderWorkspace;
  pathname: string;
}) {
  const { setOpenMobile } = useSidebar();
  const href = generalWorkspaceHref(workspace.id);
  const active = pathname.startsWith(`/workspaces/${encodeURIComponent(workspace.id)}/`);
  const [open, setOpen] = useState(active);
  const running = workspace.latest_build.status === "running";
  const capabilities = workspaceTemplateCapabilities(workspace.template_name ?? "");
  const hasTools = capabilities.editor || capabilities.fileBrowser || capabilities.desktop;

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  const agentQuery = useDiscovery(
    "agent",
    { workspaceId: workspace.id, buildId: workspace.latest_build.id },
    { enabled: open && running && hasTools },
  );
  const agent = agentQuery.data;
  const agentError = agentQuery.error;

  const tools: { label: string; tool: GeneralWorkspaceTool; icon: typeof FolderOpen }[] =
    agent && running
      ? [
          ...(capabilities.fileBrowser
            ? [{ label: "Files", tool: "files" as const, icon: FolderOpen }]
            : []),
          ...(capabilities.editor ? [{ label: "VS Code", tool: "code" as const, icon: Code }] : []),
          ...(capabilities.desktop
            ? [{ label: "Desktop", tool: "desktop" as const, icon: Monitor }]
            : []),
        ]
      : [];
  function openInWorkspace(event: React.MouseEvent, tool?: GeneralWorkspaceTool) {
    if (
      pathname !== "/workspaces" ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    setOpenMobile(false);
    window.dispatchEvent(
      new CustomEvent(GENERAL_WORKSPACE_OPEN_EVENT, {
        detail: { workspaceId: workspace.id, tool },
      }),
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SidebarMenuItem>
        <SidebarMenuButton
          render={
            hasTools ? (
              <CollapsibleTrigger />
            ) : (
              <Link href={href} onClick={(event) => openInWorkspace(event)} />
            )
          }
          isActive={active}
          aria-current={!hasTools && active ? "page" : undefined}
          aria-label={
            hasTools ? `${open ? "Collapse" : "Expand"} ${workspace.name} apps` : undefined
          }
          className="min-w-0"
          data-testid={`workspace-${hasTools ? "disclosure" : "link"}-${workspace.id}`}
          title={workspace.name}
        >
          <Monitor aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{workspace.name}</span>
          <Badge
            variant={running ? "default" : "secondary"}
            className="ml-auto shrink-0 px-1 py-0 text-[10px]"
          >
            {workspace.latest_build.status}
          </Badge>
          {hasTools && (
            <ChevronRight
              aria-hidden="true"
              className={cn("size-4 transition-transform", open && "rotate-90")}
            />
          )}
        </SidebarMenuButton>
        <CollapsibleContent id={`workspace-navigation-${workspace.id}`}>
          <SidebarMenuSub className="!mr-0 !pr-0">
            {!running && hasTools && (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton
                  render={<Link href={href} onClick={(event) => openInWorkspace(event)} />}
                >
                  <Monitor aria-hidden="true" className="size-3 shrink-0" />
                  <span>Open workspace</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
            {running && hasTools && !agent && !agentError && (
              <p className="px-2 py-1 text-xs text-muted-foreground">Loading tools…</p>
            )}
            {agentError && (
              <SidebarMenuSubItem>
                <button
                  type="button"
                  className="px-2 py-1 text-xs underline"
                  onClick={() => {
                    void agentQuery.refresh().catch(() => {});
                  }}
                >
                  Retry workspace tools
                </button>
              </SidebarMenuSubItem>
            )}
            {tools.map(({ label, tool, icon: Icon }) => (
              <SidebarMenuSubItem key={label}>
                <SidebarMenuSubButton
                  render={
                    <Link
                      href={generalWorkspaceHref(workspace.id, tool)}
                      onClick={(event) => openInWorkspace(event, tool)}
                    />
                  }
                  aria-label={`Open ${label} in workspace`}
                >
                  <Icon aria-hidden="true" className="size-3 shrink-0" />
                  <span>{label}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [sessionUser, setSessionUser] = useState<{ email: string; coderUrl: string } | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const workspaceQuery = useDiscovery("workspaces");
  const templateQuery = useDiscovery("templates", {}, { enabled: templatesOpen });
  const workspaces = {
    data: workspaceQuery.data ?? [],
    isLoading: !workspaceQuery.data && workspaceQuery.isPending,
    error: workspaceQuery.error?.message,
  };
  const templates = {
    data: templateQuery.data ?? [],
    isLoading: !templateQuery.data && templateQuery.isPending,
    error: templateQuery.error?.message,
  };
  const fetchWorkspaces = () => {
    void workspaceQuery.refresh().catch(() => {});
  };
  const fetchTemplates = () => {
    void templateQuery.refresh().catch(() => {});
  };
  const coderUrl = sessionUser?.coderUrl;
  useEffect(() => {
    getSessionAction()
      .then((result) => {
        if (result?.data?.user) setSessionUser(result.data.user);
      })
      .catch(() => {});
  }, []);
  return (
    <Sidebar variant="overlay" collapsible="offcanvas">
      <SidebarHeader className="h-14 shrink-0 flex-row items-center border-b border-sidebar-border px-4">
        <Link href="/workspaces" className="flex items-center gap-2">
          <HiveLogo className="gap-2" wordmarkClassName="text-base tracking-[0.12em]" />
        </Link>
        <div className="ml-auto">
          <WorkspaceSidebarButton />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Workspace navigation" className="flex flex-col gap-0">
          <SidebarGroup className="pb-0">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/workspaces" />}
                  isActive={pathname === "/workspaces"}
                  aria-current={pathname === "/workspaces" ? "page" : undefined}
                >
                  <LayoutDashboard className="size-4" />
                  <span>Workspace</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            {workspaces.error && (
              <Alert variant="destructive" className="my-1">
                <AlertCircle className="size-4" />
                <AlertDescription>
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
              <p className="px-2 py-2 text-xs text-muted-foreground">Loading...</p>
            )}
          </SidebarGroup>
          {(["development", "helper"] as const).map((purpose) => {
            const items = workspaces.data.filter(
              (workspace) => workspaceTemplatePurpose(workspace.template_name ?? "") === purpose,
            );
            return (
              <SidebarGroup
                key={purpose}
                className="py-1"
                data-testid={`workspace-group-${purpose}`}
              >
                <SidebarGroupLabel>
                  {purpose === "development" ? "Workspaces" : "Helpers"}
                </SidebarGroupLabel>
                <SidebarMenu>
                  {items.map((workspace) => (
                    <WorkspaceNavigationItem
                      key={workspace.id}
                      workspace={workspace}
                      pathname={pathname}
                    />
                  ))}
                </SidebarMenu>
                {!workspaces.isLoading && !workspaces.error && items.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    {purpose === "development" ? "No workspaces yet." : "No helper workspaces."}
                  </p>
                )}
              </SidebarGroup>
            );
          })}
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
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/settings" />}
              isActive={pathname === "/settings"}
              aria-current={pathname === "/settings" ? "page" : undefined}
            >
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
                    window.dispatchEvent(new Event("hive:discovery-clear"));
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
