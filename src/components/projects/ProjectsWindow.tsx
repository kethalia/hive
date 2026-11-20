"use client";

import { BookMarked, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingStatus } from "@/components/ui/loading-status";
import { PanelTabs, type PanelTabsNavigation } from "@/components/ui/panel-tabs";
import type { WorkspaceOperationState } from "@/components/workspaces/WorkspaceDetails";
import { WorkspaceTab } from "@/components/workspaces/WorkspaceTab";
import { manageProjectCheckoutAction } from "@/lib/actions/project-checkout";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { RepositoryProject } from "@/lib/projects/contracts";
import { requestHiveWindow } from "@/lib/workspaces/general-workspace";
import { ProjectBrowser } from "./ProjectBrowser";

const sections = [
  { id: "workspace", label: "Workspace", icon: <Server /> },
  { id: "repositories", label: "Projects", icon: <BookMarked /> },
] as const;

export function ProjectsWindow({
  workspaces,
  workspace,
  operation,
  visible,
  navigation,
  onStartWorkspace,
  onWorkspaceChange,
  onOpenSession,
}: {
  workspaces: CoderWorkspace[];
  workspace?: CoderWorkspace;
  operation?: WorkspaceOperationState;
  visible: boolean;
  navigation: PanelTabsNavigation;
  onStartWorkspace: (id: string) => void;
  onWorkspaceChange: (id: string) => void;
  onOpenSession: (workspaceId: string, sessionName: string, label: string) => void;
}) {
  const [section, setSection] = useState<(typeof sections)[number]["id"]>("repositories");
  const ready =
    workspace?.latest_build.status === "running" &&
    !operation?.pending &&
    operation?.failed !== "start";
  return (
    <PanelTabs
      label="Projects"
      items={sections}
      value={ready ? section : "workspace"}
      onChange={setSection}
      navigation={navigation}
      busy={!ready}
    >
      {workspace && ready && section === "repositories" ? (
        <CheckoutProjects
          key={`${workspace.id}:${workspace.latest_build.id}`}
          workspace={workspace}
          visible={visible}
          onOpenSession={onOpenSession}
          onChooseWorkspace={() => setSection("workspace")}
        />
      ) : (
        <WorkspaceTab
          workspaces={workspaces}
          workspace={workspace}
          operation={operation}
          onSelect={(item) => onWorkspaceChange(item.id)}
          onStart={(id) => {
            setSection("repositories");
            onStartWorkspace(id);
          }}
        />
      )}
    </PanelTabs>
  );
}

type Selection = { project: RepositoryProject; providerAccountId: string };
function CheckoutProjects({
  workspace,
  visible,
  onOpenSession,
  onChooseWorkspace,
}: {
  workspace: CoderWorkspace;
  visible: boolean;
  onOpenSession: (workspaceId: string, sessionName: string, label: string) => void;
  onChooseWorkspace: () => void;
}) {
  const [pending, setPending] = useState<{ action: "open" | "cleanup"; name: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function manage(action: "open" | "cleanup", { project, providerAccountId }: Selection) {
    if (locked.current) return;
    locked.current = true;
    setPending({ action, name: project.fullName });
    setError(null);
    try {
      const result = await manageProjectCheckoutAction({
        action,
        workspaceId: workspace.id,
        buildId: workspace.latest_build.id,
        repositoryId: project.providerRepositoryId,
        providerAccountId,
      });
      if (!active.current) return;
      if (!result?.data)
        throw new Error(result?.serverError ?? "Could not complete the project operation.");
      if (result.data.status === "opened")
        onOpenSession(workspace.id, result.data.sessionName, `Codex · ${result.data.fullName}`);
      else if (result.data.status === "removed") toast.success("Project checkout removed.");
      else toast.message("There is no managed checkout for this project.");
    } catch (problem) {
      if (active.current)
        setError(
          problem instanceof Error ? problem.message : "Could not complete the project operation.",
        );
    } finally {
      locked.current = false;
      if (active.current) {
        setPending(null);
        setConfirmation(null);
      }
    }
  }

  return (
    <div className="space-y-3">
      {pending && (
        <LoadingStatus>
          {pending.action === "open" ? "Opening" : "Cleaning up"} {pending.name}…
        </LoadingStatus>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ProjectBrowser
        workspaceId={workspace.id}
        enabled
        visible={visible}
        projectActionsDisabled={!!pending}
        onSelectProject={(project, providerAccountId) =>
          void manage("open", { project, providerAccountId })
        }
        onCleanupProject={(project, providerAccountId) =>
          setConfirmation({ project, providerAccountId })
        }
        onSetup={(kind) => {
          if (kind === "account")
            requestHiveWindow({ tool: "projects", workspaceId: workspace.id });
          else onChooseWorkspace();
        }}
      />
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <DialogContent showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Clean up project checkout?</DialogTitle>
            <DialogDescription>
              Remove the managed checkout for {confirmation?.project.fullName} from {workspace.name}
              . Exit Codex and save or push your work first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={!!pending} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!!pending || !confirmation}
              onClick={() => {
                if (confirmation) void manage("cleanup", confirmation);
              }}
            >
              {pending ? "Cleaning up…" : "Remove checkout"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
