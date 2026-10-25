"use client";

import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { getSettingsWindowAction } from "@/lib/actions/settings-window";
import type { CoderWorkspace } from "@/lib/coder/types";
import { type GeneralWindow, hiveToolLabels } from "@/lib/workspaces/general-workspace";
import { TerminalSessionFrame } from "./TerminalSessionFrame";

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
  onWorkspaceChange,
  onOpenSession,
}: Props) {
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
        {pane.tool === "agents" ? (
          <div className="space-y-4 p-4" data-mobile-scroll-allow="true">
            <label className="block space-y-2 text-sm">
              <span>Coder workspace</span>
              <select
                aria-label="Agent workspace"
                className="h-10 w-full min-w-0 rounded-md border bg-background px-3"
                value={workspace?.id ?? ""}
                onChange={(event) => onWorkspaceChange(event.target.value)}
              >
                {!workspaces.length ? <option value="">No workspaces available</option> : null}
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {w.latest_build.status}
                  </option>
                ))}
              </select>
            </label>
            {workspace?.latest_build.status === "running" ? (
              <AgentToolsPanel
                key={`${workspace.id}:${workspace.latest_build.id}`}
                workspaceId={workspace.id}
                buildId={workspace.latest_build.id}
                open={visible}
                onOpenSession={(sessionName) => onOpenSession(workspace.id, sessionName)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
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
