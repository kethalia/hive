"use client";

import {
  Activity,
  BookOpen,
  Link2,
  List,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { PanelTabs, type PanelTabsNavigation } from "@/components/ui/panel-tabs";
import type { CoderWorkspace } from "@/lib/coder/types";
import { useWorkspaceStart, WorkspaceTab } from "./WorkspaceTab";

const CodexAccountPanel = dynamic(() =>
  import("./CodexAccountPanel").then((m) => m.CodexAccountPanel),
);
const ClaudeAccountCard = dynamic(() =>
  import("./ClaudeAccountCard").then((m) => m.ClaudeAccountCard),
);

const commonSections = [
  { id: "workspace", label: "Workspace", icon: <Server /> },
  { id: "connection", label: "Connection", icon: <Link2 /> },
] as const;
const codexSections = [
  { id: "usage", label: "Usage", icon: <Activity /> },
  { id: "config", label: "Runtime settings", icon: <SlidersHorizontal /> },
  { id: "skills", label: "Skills", icon: <BookOpen /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle /> },
  { id: "sessions", label: "Sessions", icon: <List /> },
  { id: "integrations", label: "Integrations", icon: <Plug /> },
] as const;
const codexTabs = [...commonSections, ...codexSections];
type Section = (typeof codexTabs)[number]["id"];
export type CodexAccountSection = Exclude<Section, "workspace">;

export function AccountWorkspacePanel({
  provider,
  userId,
  workspaces,
  workspaceId,
  buildId,
  navigation,
  visible,
  onStartWorkspace,
  onWorkspaceChange,
}: {
  provider: "Codex" | "Claude";
  userId: string;
  workspaces: CoderWorkspace[];
  workspaceId?: string;
  buildId?: string;
  navigation: PanelTabsNavigation;
  visible: boolean;
  onStartWorkspace: (workspaceId: string) => Promise<void>;
  onWorkspaceChange: (workspaceId: string, buildId: string) => void;
}) {
  const [selection, setSelection] = useState<{
    section: Section;
    directory?: { scope: string; sessionId: string };
  }>({
    section: "connection",
  });
  const [managementBusy, setManagementBusy] = useState(false);
  const workspace = workspaceId
    ? workspaces.find((item) => item.id === workspaceId)
    : (workspaces.find((item) => item.latest_build.status === "running") ?? workspaces[0]);
  const status = workspace?.latest_build.status;
  const startup = useWorkspaceStart(workspace, onStartWorkspace);
  const ready =
    !!workspace &&
    status === "running" &&
    buildId === workspace.latest_build.id &&
    !startup.starting &&
    !startup.startFailed;
  const section = ready ? selection.section : "workspace";
  const scope = `${userId}/${workspace?.id ?? ""}/${buildId ?? ""}`;

  return (
    <div className="flex min-h-full min-w-0 flex-col" data-mobile-scroll-allow="true">
      <PanelTabs
        label={`${provider} settings`}
        items={provider === "Codex" ? codexTabs : commonSections}
        value={section}
        onChange={(section) => setSelection({ section })}
        busy={!ready || managementBusy}
        navigation={navigation}
      >
        {section === "workspace" ? (
          <WorkspaceTab
            workspaces={workspaces}
            workspace={workspace}
            starting={startup.starting}
            startFailed={startup.startFailed}
            onSelect={(item) => {
              startup.clear();
              setSelection({ section: "workspace" });
              onWorkspaceChange(item.id, item.latest_build.id);
            }}
            onStart={(id) => void startup.start(id, () => setSelection({ section: "connection" }))}
            onUseCurrentBuild={
              workspace && !ready
                ? () => {
                    onWorkspaceChange(workspace.id, workspace.latest_build.id);
                    setSelection({ section: "connection" });
                  }
                : undefined
            }
          />
        ) : visible && workspace && buildId ? (
          <Suspense
            fallback={
              <p role="status" className="text-muted-foreground">
                Loading {provider}…
              </p>
            }
          >
            {provider === "Codex" ? (
              <CodexAccountPanel
                key={scope}
                workspaceId={workspace.id}
                buildId={buildId}
                section={section}
                directorySession={
                  selection.directory?.scope === scope ? selection.directory.sessionId : undefined
                }
                managementBusy={managementBusy}
                onBusyChange={setManagementBusy}
                onSessionSkills={(sessionId) =>
                  setSelection({ section: "skills", directory: { scope, sessionId } })
                }
                onWorkspaceSkills={() => setSelection({ section: "skills" })}
              />
            ) : (
              <ClaudeAccountCard key={scope} workspaceId={workspace.id} buildId={buildId} />
            )}
          </Suspense>
        ) : null}
      </PanelTabs>
    </div>
  );
}
