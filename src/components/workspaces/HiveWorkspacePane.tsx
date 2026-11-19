"use client";

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, PanelLeftClose, PanelLeftOpen, Play } from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PanelTabsNavigation } from "@/components/ui/panel-tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CoderWorkspace } from "@/lib/coder/types";
import { fetchSettingsWindow } from "@/lib/settings/window-client";
import { cn } from "@/lib/utils";
import {
  type GeneralWindow,
  hiveToolLabels,
  isAccountTool,
  requestHiveWindow,
} from "@/lib/workspaces/general-workspace";
import { TerminalSessionFrame } from "./TerminalSessionFrame";

const CodexAccountPanel = dynamic(() =>
  import("./CodexAccountPanel").then((m) => m.CodexAccountPanel),
);
const ClaudeAccountCard = dynamic(() =>
  import("./ClaudeAccountCard").then((m) => m.ClaudeAccountCard),
);
const AgentToolsPanel = dynamic(() => import("./AgentToolsPanel").then((m) => m.AgentToolsPanel));
const WorkspaceListContent = dynamic(() =>
  import("@/app/(dashboard)/workspaces/workspace-list-content").then((m) => m.WorkspaceListContent),
);
const Diagnostics = dynamic(() =>
  import("./TerminalSessionStatusClient").then((m) => m.TerminalSessionStatusClient),
);
const SettingsContent = dynamic(() =>
  import("@/components/settings-content").then((m) => m.SettingsContent),
);

const Logs = dynamic(() =>
  import("./TerminalSessionEventLog").then((m) => m.TerminalSessionEventLog),
);
const TemplatesWindow = dynamic(() => import("./TemplatesWindow").then((m) => m.TemplatesWindow));

function SettingsWindow({
  userId,
  navigation,
}: {
  userId: string;
  navigation: PanelTabsNavigation;
}) {
  const query = useQuery({
    queryKey: ["settings-window", userId],
    queryFn: ({ signal }) => fetchSettingsWindow(signal),
    staleTime: 30_000,
    retry: false,
  });
  if (query.isPending)
    return (
      <p role="status" className="p-4 text-sm">
        Loading settings…
      </p>
    );
  if (query.isError || !query.data)
    return (
      <div className="space-y-3 p-4">
        <p role="alert">Settings are unavailable.</p>
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  return <SettingsContent {...query.data} navigation={navigation} />;
}

interface Props {
  pane: Extract<GeneralWindow, { kind: "hive" }>;
  userId: string;
  workspaces: CoderWorkspace[];
  active: boolean;
  visible: boolean;
  launchRequest: number;
  dragHandleListeners?: DraggableSyntheticListeners;
  onActivate: () => void;
  onClose: () => void;
  onCycleWidth?: () => void;
  onStartWorkspace: (workspaceId: string) => Promise<void>;
  onWorkspaceChange: (workspaceId: string, buildId?: string) => void;
  onOpenSession: (workspaceId: string, sessionName: string) => void;
}

export function HiveWorkspacePane({
  pane,
  userId,
  workspaces,
  active,
  visible,
  launchRequest,
  dragHandleListeners,
  onActivate,
  onClose,
  onCycleWidth,
  onStartWorkspace,
  onWorkspaceChange,
  onOpenSession,
}: Props) {
  const workspaceSelectId = useId();
  const navigationId = useId();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [startup, setStartup] = useState<{ id: string; pending: boolean } | null>(null);
  const navigation = { id: navigationId, collapsed: sidebarCollapsed };
  const accountTool = isAccountTool(pane.tool);
  const codexTool = pane.tool === "codex-account";
  const selectedWorkspace = workspaces.find((w) => w.id === pane.workspaceId);
  const workspace =
    accountTool && pane.workspaceId
      ? selectedWorkspace
      : (selectedWorkspace ??
        workspaces.find((w) => w.latest_build.status === "running") ??
        workspaces[0]);
  const status = workspace?.latest_build.status;
  const starting = startup?.id === workspace?.id && startup?.pending === true;
  const startFailed = startup?.id === workspace?.id && startup?.pending === false;
  const workspaceReady = status === "running";
  const matchingBuild = pane.buildId && pane.buildId === workspace?.latest_build.id;
  const hasSidebar = pane.tool === "settings" || (codexTool && workspaceReady && matchingBuild);
  async function startSelectedWorkspace(id: string) {
    setStartup({ id, pending: true });
    try {
      await onStartWorkspace(id);
      setStartup(null);
    } catch {
      setStartup({ id, pending: false });
    }
  }
  return (
    <TerminalSessionFrame
      label={hiveToolLabels[pane.tool]}
      subtitle={
        pane.tool === "logs" && pane.workspaceId
          ? `${workspaces.find((w) => w.id === pane.workspaceId)?.name ?? pane.workspaceId}${pane.sessionName ? ` · ${pane.sessionName}` : ""}`
          : "Hive"
      }
      active={active && visible}
      className="h-full"
      contentClassName="overflow-y-auto overscroll-contain"
      layoutMode="tiled"
      dragHandleListeners={dragHandleListeners}
      onActivate={onActivate}
      onFocusActivate
      onClose={onClose}
      onCycleWidth={onCycleWidth}
      headerActions={
        hasSidebar && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            aria-expanded={!sidebarCollapsed}
            aria-controls={navigationId}
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen aria-hidden="true" />
            ) : (
              <PanelLeftClose aria-hidden="true" />
            )}
          </Button>
        )
      }
      closeLabel={`Close ${hiveToolLabels[pane.tool]}`}
      dataTestId={`hive-window-${pane.tool}`}
    >
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm">
            Loading {hiveToolLabels[pane.tool].toLowerCase()}…
          </p>
        }
      >
        {pane.tool === "agents" || accountTool ? (
          <div
            className={codexTool ? "flex min-h-full flex-col" : "space-y-4 p-4"}
            data-mobile-scroll-allow="true"
          >
            <div className={cn("space-y-2 text-sm", codexTool && "p-4")}>
              <label htmlFor={workspaceSelectId} className={accountTool ? "sr-only" : "block"}>
                Coder workspace
              </label>
              <Select
                value={workspace?.id ?? null}
                onValueChange={(value) => {
                  if (value) {
                    setStartup(null);
                    onWorkspaceChange(
                      value,
                      accountTool
                        ? workspaces.find((w) => w.id === value)?.latest_build.id
                        : undefined,
                    );
                  }
                }}
                disabled={!workspaces.length || starting}
                items={workspaces.map((w) => ({
                  value: w.id,
                  label: `${w.name} · ${w.latest_build.status}`,
                }))}
              >
                <SelectTrigger
                  id={workspaceSelectId}
                  aria-label={accountTool ? "Account workspace" : "Agent workspace"}
                  size={accountTool ? "sm" : "default"}
                  className={accountTool ? "max-w-full" : "w-full"}
                >
                  <SelectValue
                    className={accountTool ? "min-w-0 truncate" : undefined}
                    placeholder={
                      workspaces.length ? "Choose a workspace" : "No workspaces available"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} · {w.latest_build.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {accountTool && starting ? (
              <p
                role="status"
                className={cn(
                  "flex items-center gap-2 text-sm text-muted-foreground",
                  codexTool && "px-4 pb-4",
                )}
              >
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                Starting {workspace?.name}…
              </p>
            ) : accountTool && workspace && (status === "stopped" || startFailed) ? (
              <div className={cn("space-y-3", codexTool && "px-4 pb-4")}>
                {startFailed && (
                  <p role="alert" className="text-sm text-destructive">
                    Could not open {workspace.name}.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(status === "stopped" || status === "running") && (
                    <Button onClick={() => void startSelectedWorkspace(workspace.id)}>
                      <Play aria-hidden />
                      {status === "running" ? "Retry" : "Start workspace"}
                    </Button>
                  )}
                  {startFailed && (
                    <Button
                      variant="outline"
                      onClick={() => requestHiveWindow({ tool: "workspaces" })}
                    >
                      Coder workspaces
                    </Button>
                  )}
                </div>
              </div>
            ) : workspace && workspaceReady ? (
              accountTool ? (
                !matchingBuild ? (
                  <div className={cn("space-y-3", codexTool && "px-4 pb-4")}>
                    <p role="status">Select this workspace’s current build to manage accounts.</p>
                    <Button
                      onClick={() => onWorkspaceChange(workspace.id, workspace.latest_build.id)}
                    >
                      Use current build
                    </Button>
                  </div>
                ) : visible ? (
                  codexTool ? (
                    <CodexAccountPanel
                      key={`${userId}/${workspace.id}/${workspace.latest_build.id}`}
                      workspaceId={workspace.id}
                      buildId={workspace.latest_build.id}
                      navigation={navigation}
                    />
                  ) : (
                    <ClaudeAccountCard
                      key={`${userId}/${workspace.id}/${workspace.latest_build.id}`}
                      workspaceId={workspace.id}
                      buildId={workspace.latest_build.id}
                    />
                  )
                ) : null
              ) : (
                <AgentToolsPanel
                  key={`${workspace.id}:${workspace.latest_build.id}`}
                  workspaceId={workspace.id}
                  buildId={workspace.latest_build.id}
                  open={visible}
                  onOpenSession={(sessionName) => onOpenSession(workspace.id, sessionName)}
                />
              )
            ) : (
              <p
                role="status"
                className={cn("text-sm text-muted-foreground", codexTool && "px-4 pb-4")}
              >
                {accountTool
                  ? pane.workspaceId && !workspace
                    ? "The selected workspace is unavailable. Choose another workspace."
                    : status === "starting" || status === "pending"
                      ? "Waiting for the workspace to start…"
                      : workspace
                        ? `Workspace is ${status}. Manage it in Coder workspaces.`
                        : "Choose a workspace to manage its accounts."
                  : "Start a Coder workspace to view its agent conversations."}
              </p>
            )}
          </div>
        ) : pane.tool === "workspaces" ? (
          <WorkspaceListContent
            workspaces={workspaces}
            launchRequest={launchRequest}
            visible={visible}
            embedded
          />
        ) : pane.tool === "templates" ? (
          <TemplatesWindow userId={userId} template={pane.template} />
        ) : pane.tool === "logs" ? (
          <div className="p-4">
            <Logs
              visible={visible}
              key={`${pane.workspaceId ?? ""}:${pane.sessionName ?? ""}`}
              workspaceId={pane.workspaceId}
              sessionName={pane.sessionName}
            />
          </div>
        ) : pane.tool === "diagnostics" ? (
          <Diagnostics visible={visible} highlightedWorkspaceId={pane.workspaceId} />
        ) : (
          <SettingsWindow userId={userId} navigation={navigation} />
        )}
      </Suspense>
    </TerminalSessionFrame>
  );
}
