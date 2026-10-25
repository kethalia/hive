"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandPalettePage } from "@/components/terminal/CommandPalette";
import { cloneProjectAction } from "@/lib/actions/clone-project";
import { createSessionAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import { cloneProjectSchema } from "@/lib/git/clone-project";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";
import { terminalNameError } from "@/lib/workspaces/terminal-selection";

/** Creation stays in the launcher's command input; only successful mutations open a window. */
export function useWindowCreationPages({
  workspaces,
  initialWorkspaceId,
  open,
  onOpenPane,
}: {
  workspaces: CoderWorkspace[];
  initialWorkspaceId?: string;
  open: boolean;
  onOpenPane: (pane: GeneralPane) => void;
}): Record<string, CommandPalettePage> {
  const client = useQueryClient();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [organization, setOrganization] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      setChosenId(null);
      setOrganization("");
    }
  }, [open]);
  return useMemo(() => {
    const running = workspaces.filter((w) => w.latest_build.status === "running");
    const workspace =
      chosenId !== null
        ? running.find((w) => w.id === chosenId)
        : (running.find((w) => w.id === initialWorkspaceId) ??
          running.find((w) => w.template_name === "ai-dev-k8s") ??
          running[0]);
    const workspaceActions = [
      {
        id: "creation-workspace",
        label: workspace ? `Workspace: ${workspace.name}` : "Choose a running workspace",
        group: "Destination",
        icon: "desktop" as const,
        rightLabel: "Change",
        onSelect: () => ({ page: "creation-workspace" }),
      },
    ];
    async function create(kind: "terminal" | "project", name: string) {
      if (!workspace) throw new Error("Choose a running Coder workspace.");
      let pane: GeneralPane;
      if (kind === "terminal") {
        if (!name) throw new Error("Enter a session name.");
        const invalid = terminalNameError(name);
        if (invalid) throw new Error(invalid);
        const result = await createSessionAction({ workspaceId: workspace.id, sessionName: name });
        if (!result?.data) throw new Error(result?.serverError ?? "Could not create the session.");
        pane = {
          kind: "terminal",
          workspaceId: workspace.id,
          sessionName: result.data.name,
          label: result.data.name,
        };
      } else {
        const input = cloneProjectSchema.safeParse({
          workspaceId: workspace.id,
          organization,
          repository: name,
        });
        if (!input.success) throw new Error(input.error.issues[0].message);
        const result = await cloneProjectAction(input.data);
        if (!result?.data)
          throw new Error(
            result?.serverError ??
              "Could not clone the project. Check the organization and repository names.",
          );
        pane = result.data;
      }
      void client.invalidateQueries({
        queryKey: ["discovery", kind === "terminal" ? "sessions" : "repositories", workspace.id],
      });
      if (mounted.current) onOpenPane(pane);
    }
    return {
      "create-terminal": {
        title: "Create terminal",
        searchPlaceholder: "Session name…",
        actions: workspaceActions,
        input: {
          label: "Session name",
          maxLength: 200,
          submitLabel: "Create terminal",
          pendingLabel: "Opening session…",
          onSubmit: (name) => create("terminal", name),
        },
      },
      "create-project": {
        title: "New project",
        searchPlaceholder: "GitHub organization or owner…",
        actions: workspaceActions,
        input: {
          label: "Organization or owner",
          maxLength: 39,
          submitLabel: "Continue to repository",
          pendingLabel: "Continuing…",
          onSubmit: (name) => {
            const owner = cloneProjectSchema.shape.organization.safeParse(name);
            if (!owner.success) throw new Error("Enter a GitHub organization or owner.");
            setOrganization(owner.data);
            return { page: "create-project-repository" };
          },
        },
      },
      "create-project-repository": {
        title: `New project · ${organization}`,
        searchPlaceholder: "Repository name…",
        actions: workspaceActions,
        input: {
          label: "Repository",
          maxLength: 100,
          submitLabel: "Clone and open",
          pendingLabel: "Cloning project…",
          onSubmit: (name) => create("project", name),
        },
      },
      "creation-workspace": {
        title: "Coder workspace",
        searchPlaceholder: "Search running workspaces…",
        emptyText: "No running workspaces. Start one from Manage Coder workspaces.",
        actions: running.map((w) => ({
          id: `choose-workspace:${w.id}`,
          label: w.name,
          group: "Running workspaces",
          rightLabel: w.id === workspace?.id ? "Selected" : undefined,
          onSelect: () => {
            setChosenId(w.id);
            return { back: true };
          },
        })),
      },
    };
  }, [workspaces, initialWorkspaceId, chosenId, organization, client, onOpenPane]);
}
