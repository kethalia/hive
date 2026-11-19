"use client";

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, useId, useState } from "react";
import { useRuntimeConfig } from "@/components/runtime-config-provider";
import { Button } from "@/components/ui/button";
import type { PanelTabsNavigation } from "@/components/ui/panel-tabs";
import type { CoderWorkspace } from "@/lib/coder/types";
import { fetchSettingsWindow } from "@/lib/settings/window-client";
import {
  type GeneralWindow,
  hiveToolLabels,
  isAccountTool,
} from "@/lib/workspaces/general-workspace";
import { AccountWorkspacePanel } from "./AccountWorkspacePanel";
import { TerminalSessionFrame } from "./TerminalSessionFrame";
import { WorkspacePicker } from "./WorkspacePicker";

const GitHubWindow = dynamic(() =>
  import("@/components/projects/GitHubWindow").then((m) => m.GitHubWindow),
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
  const { projectDiscoveryEnabled } = useRuntimeConfig();
  const projectWorkspace =
    pane.tool !== "projects"
      ? undefined
      : pane.workspaceId
        ? workspaces.find((w) => w.id === pane.workspaceId)
        : (workspaces.find((w) => w.latest_build.status === "running") ?? workspaces[0]);
  const navigationId = useId();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navigation = { id: navigationId, collapsed: sidebarCollapsed };
  const accountTool = isAccountTool(pane.tool);
  const agentWorkspace =
    pane.tool === "agents"
      ? (workspaces.find((w) => w.id === pane.workspaceId) ??
        workspaces.find((w) => w.latest_build.status === "running") ??
        workspaces[0])
      : undefined;
  const hasSidebar =
    pane.tool === "settings" ||
    (pane.tool === "projects" && !!projectDiscoveryEnabled) ||
    accountTool;
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
        {accountTool ? (
          <AccountWorkspacePanel
            provider={pane.tool === "codex-account" ? "Codex" : "Claude"}
            userId={userId}
            workspaces={workspaces}
            workspaceId={pane.workspaceId}
            buildId={pane.buildId}
            navigation={navigation}
            visible={visible}
            onStartWorkspace={onStartWorkspace}
            onWorkspaceChange={onWorkspaceChange}
          />
        ) : pane.tool === "projects" ? (
          projectDiscoveryEnabled ? (
            <GitHubWindow
              key={userId}
              userId={userId}
              workspaces={workspaces}
              workspace={projectWorkspace}
              onStartWorkspace={onStartWorkspace}
              onWorkspaceChange={onWorkspaceChange}
              visible={visible}
              navigation={navigation}
            />
          ) : (
            <p className="p-4">Repository discovery is disabled.</p>
          )
        ) : pane.tool === "agents" ? (
          <div className="space-y-4 p-4" data-mobile-scroll-allow="true">
            <WorkspacePicker
              label="Agent workspace"
              workspaces={workspaces}
              selected={agentWorkspace?.id}
              onSelect={onWorkspaceChange}
            />
            {agentWorkspace?.latest_build.status === "running" ? (
              <AgentToolsPanel
                key={`${agentWorkspace.id}:${agentWorkspace.latest_build.id}`}
                workspaceId={agentWorkspace.id}
                buildId={agentWorkspace.latest_build.id}
                open={visible}
                onOpenSession={(sessionName) => onOpenSession(agentWorkspace.id, sessionName)}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Start a Coder workspace to view its agent conversations.
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
