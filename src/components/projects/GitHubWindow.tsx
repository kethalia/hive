"use client";

import { BookMarked, Link2, Server, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { PanelTabs, type PanelTabsNavigation } from "@/components/ui/panel-tabs";
import { useWorkspaceStart, WorkspaceTab } from "@/components/workspaces/WorkspaceTab";
import type { CoderWorkspace } from "@/lib/coder/types";
import { GitHubConnection } from "./GitHubConnection";
import { GitHubPermissions } from "./GitHubPermissions";
import { ProjectBrowser } from "./ProjectBrowser";

const sections = [
  { id: "workspace", label: "Workspace", icon: <Server /> },
  { id: "connection", label: "Connection", icon: <Link2 /> },
  { id: "permissions", label: "Permissions", icon: <ShieldCheck /> },
  { id: "repositories", label: "Repositories", icon: <BookMarked /> },
] as const;

export function GitHubWindow({
  userId,
  workspaces,
  workspace,
  onWorkspaceChange,
  onStartWorkspace,
  visible,
  navigation,
}: {
  userId: string;
  workspaces: CoderWorkspace[];
  workspace?: CoderWorkspace;
  onWorkspaceChange: (id: string) => void;
  onStartWorkspace: (id: string) => Promise<void>;
  visible: boolean;
  navigation: PanelTabsNavigation;
}) {
  const startup = useWorkspaceStart(workspace, onStartWorkspace);
  const [selection, setSection] = useState<(typeof sections)[number]["id"]>("connection");
  const ready =
    workspace?.latest_build.status === "running" && !startup.starting && !startup.startFailed;
  const section = ready ? selection : "workspace";
  return (
    <PanelTabs
      label="GitHub"
      items={sections}
      value={section}
      onChange={setSection}
      navigation={navigation}
      busy={!ready}
    >
      {section === "workspace" ? (
        <WorkspaceTab
          workspaces={workspaces}
          workspace={workspace}
          starting={startup.starting}
          startFailed={startup.startFailed}
          onSelect={(item) => {
            startup.clear();
            setSection("workspace");
            onWorkspaceChange(item.id);
          }}
          onStart={(id) => void startup.start(id, () => setSection("connection"))}
        />
      ) : workspace && section === "permissions" ? (
        <GitHubPermissions
          key={workspace.id}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          userId={userId}
        />
      ) : workspace && section === "repositories" ? (
        <ProjectBrowser
          key={workspace.latest_build.id}
          workspaceId={workspace.id}
          enabled
          visible={visible}
          onSetup={(kind) => {
            setSection(kind === "account" ? "connection" : "workspace");
          }}
        />
      ) : workspace ? (
        <GitHubConnection
          onManage={() => setSection("permissions")}
          key={workspace.id + workspace.latest_build.id}
          workspace={workspace}
          userId={userId}
          visible={visible}
        />
      ) : null}
    </PanelTabs>
  );
}
