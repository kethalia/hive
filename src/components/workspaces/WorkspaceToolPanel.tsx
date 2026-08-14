"use client";

import {
  AlertCircle,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  LayoutDashboard,
  Monitor,
  TerminalSquare,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CoderWorkspace } from "@/lib/coder/types";
import { workspaceTemplateCapabilities } from "@/lib/templates/catalog";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";

const TerminalTabManager = dynamic(
  () => import("@/components/workspaces/TerminalTabManager").then((m) => m.TerminalTabManager),
  { ssr: false },
);

const tools = [
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "filebrowser", label: "Filebrowser", icon: FolderOpen },
  { id: "kasmvnc", label: "KasmVNC", icon: Monitor },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
] as const;

type ToolId = (typeof tools)[number]["id"];

interface WorkspaceToolPanelProps {
  workspace: CoderWorkspace;
  agentId: string;
  agentName: string;
  coderUrl: string;
}

export function WorkspaceToolPanel({
  workspace,
  agentId,
  agentName,
  coderUrl,
}: WorkspaceToolPanelProps) {
  const [activeTool, setActiveTool] = useState<ToolId>("terminal");
  const [toolPickerOpen, setToolPickerOpen] = useState(false);

  const urls = buildWorkspaceUrls(workspace, agentName, coderUrl);
  const isRunning = workspace.latest_build.status === "running";
  const capabilities = workspaceTemplateCapabilities(workspace.template_name ?? "");
  const availableTools = tools.filter(({ id }) => {
    if (id === "filebrowser") return capabilities.fileBrowser;
    if (id === "kasmvnc") return capabilities.desktop;
    return true;
  });
  const resolvedActiveTool = availableTools.some(({ id }) => id === activeTool)
    ? activeTool
    : "terminal";

  const activeDef = availableTools.find((tool) => tool.id === resolvedActiveTool) ?? tools[0];
  const ActiveIcon = activeDef.icon;

  const proxyBase = `/api/workspace-proxy/${workspace.id}`;
  const iframeUrlMap: Record<string, string> = {
    filebrowser: `${proxyBase}/filebrowser`,
    kasmvnc: `${proxyBase}/kasmvnc`,
  };
  const directUrlMap: Record<string, string | undefined> = {
    filebrowser: urls?.filebrowser,
    kasmvnc: urls?.kasmvnc,
    dashboard: urls?.dashboard,
  };
  const activeUrl = directUrlMap[resolvedActiveTool];

  if (!isRunning) {
    return (
      <Alert>
        <AlertCircle />
        <AlertDescription>
          Workspace must be running to use embedded tools. Current status:{" "}
          <span className="font-medium text-foreground">{workspace.latest_build.status}</span>
        </AlertDescription>
        {urls && (
          <div className="mt-3 flex gap-2">
            {capabilities.fileBrowser && (
              <Button variant="outline" size="sm" disabled>
                <FolderOpen data-icon="inline-start" />
                Filebrowser
              </Button>
            )}
            {capabilities.desktop && (
              <Button variant="outline" size="sm" disabled>
                <Monitor data-icon="inline-start" />
                KasmVNC
              </Button>
            )}
            <Button variant="outline" size="sm" disabled>
              <LayoutDashboard data-icon="inline-start" />
              Dashboard
            </Button>
          </div>
        )}
      </Alert>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link href="/workspaces" />}>Workspaces</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{workspace.name}</BreadcrumbPage>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <Popover open={toolPickerOpen} onOpenChange={setToolPickerOpen}>
                <PopoverTrigger
                  className="flex items-center gap-1 font-normal text-foreground hover:text-foreground/80"
                  data-testid="tool-picker-trigger"
                >
                  <ActiveIcon className="size-3.5" />
                  {activeDef.label}
                  <ChevronDown className="size-3" />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-48 p-1">
                  {availableTools.map((tool) => {
                    const Icon = tool.icon;
                    return (
                      <button
                        type="button"
                        key={tool.id}
                        onClick={() => {
                          setActiveTool(tool.id);
                          setToolPickerOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent ${
                          tool.id === resolvedActiveTool
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground"
                        }`}
                        data-testid={`tool-option-${tool.id}`}
                      >
                        <Icon className="size-4" />
                        {tool.label}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="ml-auto flex items-center gap-2">
          {activeUrl && (
            <Button variant="ghost" size="sm" onClick={() => window.open(activeUrl, "_blank")}>
              <ExternalLink data-icon="inline-start" />
              Pop Out
            </Button>
          )}
        </div>
      </div>

      <div className="relative flex-1">
        {/* Terminal — always mounted, hidden via CSS */}
        <div
          className="absolute inset-0"
          style={{ display: resolvedActiveTool === "terminal" ? "block" : "none" }}
        >
          {agentId && <TerminalTabManager agentId={agentId} workspaceId={workspace.id} />}
        </div>

        {/* Proxied iframe tools */}
        {availableTools
          .filter(({ id }) => id === "filebrowser" || id === "kasmvnc")
          .map((tool) => (
            <div
              key={tool.id}
              className="absolute inset-0"
              style={{ display: resolvedActiveTool === tool.id ? "flex" : "none" }}
            >
              <iframe
                src={iframeUrlMap[tool.id]}
                title={tool.label}
                className="h-full w-full rounded-lg border border-border"
                allow="clipboard-read; clipboard-write"
              />
            </div>
          ))}

        {/* Dashboard — opens externally (Coder UI can't be proxied reliably) */}
        {resolvedActiveTool === "dashboard" && (
          <div className="absolute inset-0 flex">
            <ExternalToolPlaceholder label="Dashboard" url={urls?.dashboard} />
          </div>
        )}
      </div>
    </div>
  );
}

function ExternalToolPlaceholder({ label, url }: { label: string; url?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 rounded-lg border border-border bg-muted/30 p-8 text-center">
      <LayoutDashboard className="size-8 text-muted-foreground" />
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{label} opens in a new tab</p>
        <p className="text-xs text-muted-foreground max-w-md">
          The Coder dashboard has too many internal routes to proxy reliably. Click below to open it
          directly.
        </p>
      </div>
      {url && (
        <Button variant="outline" size="sm" onClick={() => window.open(url, "_blank")}>
          <ExternalLink data-icon="inline-start" />
          Open {label}
        </Button>
      )}
    </div>
  );
}
