"use client";

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Suspense, useId } from "react";
import { useRuntimeConfig } from "@/components/runtime-config-provider";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSettingsWindowAction } from "@/lib/actions/settings-window";
import type { CoderWorkspace } from "@/lib/coder/types";
import { type GeneralWindow, hiveToolLabels } from "@/lib/workspaces/general-workspace";
import { TerminalSessionFrame } from "./TerminalSessionFrame";

const DeliveryPanel = dynamic(() =>
  import("@/components/delivery/DeliveryPanel").then((m) => m.DeliveryPanel),
);
const ProjectWorkspacePanel = dynamic(() =>
  import("@/components/projects/ProjectWorkspacePanel").then((m) => m.ProjectWorkspacePanel),
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

function SettingsWindow({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ["settings-window", userId],
    queryFn: async () => {
      const result = await getSettingsWindowAction();
      if (!result?.data) throw new Error(result?.serverError ?? "Could not load settings.");
      return result.data;
    },
    staleTime: 30_000,
  });
  if (query.isPending)
    return (
      <p role="status" className="p-4 text-sm">
        Loading settings…
      </p>
    );
  if (!query.data)
    return (
      <div className="space-y-3 p-4">
        <p role="alert">Settings are unavailable.</p>
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  return <SettingsContent {...query.data} />;
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
  onWorkspaceChange: (workspaceId: string) => void;
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
  onWorkspaceChange,
  onOpenSession,
}: Props) {
  const workspaceSelectId = useId();
  const { projectDiscoveryEnabled, projectTasksEnabled, deliveryEnabled } = useRuntimeConfig();
  const workspace =
    workspaces.find((w) => w.id === pane.workspaceId) ??
    workspaces.find((w) => w.latest_build.status === "running") ??
    workspaces[0];
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
        {pane.tool === "delivery" ? (
          <DeliveryPanel
            key={userId}
            userId={userId}
            enabled={Boolean(deliveryEnabled)}
            visible={visible}
            taskId={pane.taskId}
            reportId={pane.reportId}
          />
        ) : pane.tool === "agents" || pane.tool === "projects" ? (
          <div className="space-y-4 p-4" data-mobile-scroll-allow="true">
            <div className="space-y-2 text-sm">
              <label htmlFor={workspaceSelectId} className="block">
                Coder workspace
              </label>
              <Select
                value={workspace?.id ?? null}
                onValueChange={(value) => {
                  if (value) onWorkspaceChange(value);
                }}
                disabled={!workspaces.length}
                items={workspaces.map((w) => ({
                  value: w.id,
                  label: `${w.name} · ${w.latest_build.status}`,
                }))}
              >
                <SelectTrigger
                  id={workspaceSelectId}
                  aria-label={pane.tool === "projects" ? "Project workspace" : "Agent workspace"}
                  className="w-full"
                >
                  <SelectValue placeholder="No workspaces available" />
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
            {workspace?.latest_build.status === "running" ? (
              pane.tool === "projects" ? (
                <ProjectWorkspacePanel
                  key={workspace.id}
                  workspaceId={workspace.id}
                  enabled={Boolean(projectDiscoveryEnabled)}
                  tasksEnabled={Boolean(projectTasksEnabled)}
                  visible={visible}
                />
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
              <p className="text-sm text-muted-foreground">
                {pane.tool === "projects"
                  ? "Start a Coder workspace to browse connected repositories."
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
          <TemplatesWindow template={pane.template} />
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
          <SettingsWindow userId={userId} />
        )}
      </Suspense>
    </TerminalSessionFrame>
  );
}
