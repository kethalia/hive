"use client";

import { useEffect, useState } from "react";
import type {
  CommandPaletteAction,
  CommandPalettePage,
} from "@/components/terminal/CommandPalette";
import type { WorkspaceOperationState } from "@/components/workspaces/WorkspaceDetails";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { ProjectTerminalRequest } from "@/lib/workspaces/general-workspace";
import { requestHiveWindow } from "@/lib/workspaces/general-workspace";
import { useProjectRepositories } from "./useProjectRepositories";

export function useProjectsPalette({
  enabled,
  open,
  query,
  workspaces,
  initialWorkspaceId,
  operations,
  onStart,
  onOpenProject,
}: {
  enabled: boolean;
  open: boolean;
  query: string;
  workspaces: CoderWorkspace[];
  initialWorkspaceId?: string;
  operations?: Record<string, WorkspaceOperationState>;
  onStart: (id: string) => Promise<void>;
  onOpenProject: (project: ProjectTerminalRequest) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const workspace = workspaces.find((item) => item.id === selectedId);
  const operation = workspace && operations?.[workspace.id];
  const status = workspace?.latest_build.status;
  const ready = status === "running" && !operation?.pending && operation?.failed !== "start";
  const { snapshot, load } = useProjectRepositories(
    workspace?.id ?? "",
    enabled && open && ready,
    workspace?.latest_build.id,
  );

  useEffect(() => {
    if (!open) setSelectedId(undefined);
  }, [open]);

  if (!enabled) return { pages: {} };

  const browse: CommandPaletteAction = {
    id: "browse-projects",
    label: "Projects",
    group: "Hive",
    icon: "files",
    description: "Open GitHub repositories in a terminal",
    rightLabel: "Browse",
    onSelect: () => {
      const running = workspaces.filter((item) => item.latest_build.status === "running");
      const target = running.find((item) => item.id === initialWorkspaceId) ?? running[0];
      setSelectedId(target?.id);
      return { page: target ? "projects:repositories" : "projects:workspaces" };
    },
  };

  const actions: CommandPaletteAction[] = [];
  const starting = operation?.pending === "start" || status === "starting" || status === "pending";
  if (
    workspace &&
    !ready &&
    !starting &&
    !operation?.pending &&
    (status === "stopped" || operation?.failed === "start")
  ) {
    actions.push({
      id: "projects:start-workspace",
      label: "Start workspace",
      group: "Workspace",
      description: workspace.name,
      closeOnSelect: false,
      onSelect: () => void onStart(workspace.id).catch(() => {}),
    });
  }

  const accountId = snapshot.providerAccountId;
  if (workspace && ready && accountId) {
    for (const repository of snapshot.repositories) {
      actions.push({
        id: `projects:repository:${repository.providerRepositoryId}`,
        label: repository.fullName,
        group: "Projects",
        icon: "files",
        rightLabel: "Open terminal",
        onSelect: () =>
          onOpenProject({
            workspaceId: workspace.id,
            buildId: workspace.latest_build.id,
            repositoryId: repository.providerRepositoryId,
            providerAccountId: accountId,
            fullName: repository.fullName,
          }),
      });
    }
  }

  actions.push({
    id: "projects:choose-workspace",
    label: "Choose workspace",
    group: "Workspace",
    icon: "desktop",
    onSelect: () => ({ page: "projects:workspaces" }),
  });
  if (workspace && ready && (snapshot.loaded || snapshot.error)) {
    actions.push({
      id: "projects:refresh",
      label: "Refresh repositories",
      group: "Workspace",
      closeOnSelect: false,
      disabled: !!snapshot.loading,
      onSelect: () => void load(),
    });
    if (snapshot.setup === "account") {
      actions.push({
        id: "projects:github-connection",
        label: "Manage GitHub connection",
        group: "Workspace",
        onSelect: () => requestHiveWindow({ tool: "projects", workspaceId: workspace.id }),
      });
    }
  }
  const nextPage = snapshot.nextPage;
  if (ready && nextPage !== null) {
    actions.push({
      id: "projects:load-more",
      label: "Load more repositories",
      group: "Workspace",
      aliases: query ? [query] : undefined,
      closeOnSelect: false,
      disabled: !!snapshot.loading,
      onSelect: () => void load(nextPage),
    });
  }
  const pages: Record<string, CommandPalettePage> = {
    "projects:workspaces": {
      title: "Projects · Workspace",
      searchPlaceholder: "Search workspaces…",
      emptyText: "No matching workspaces.",
      actions: workspaces.map((item) => ({
        id: `projects:workspace:${item.id}`,
        label: item.name,
        group: "Workspaces",
        rightLabel: item.latest_build.status,
        icon: "desktop",
        onSelect: () => {
          setSelectedId(item.id);
          return { page: "projects:repositories" };
        },
      })),
    },
    "projects:repositories": {
      title: workspace ? `Projects · ${workspace.name}` : "Projects",
      searchPlaceholder: "Search projects…",
      emptyText: "No matching projects.",
      loadingText: starting
        ? `Starting ${workspace?.name}…`
        : ready && ((!snapshot.loaded && !snapshot.error) || snapshot.loading)
          ? "Loading repositories…"
          : undefined,
      actions: [
        ...actions,
        ...(operation?.error ||
        snapshot.error ||
        (ready && snapshot.loaded && !snapshot.repositories.length)
          ? [
              {
                id: "projects:status",
                label: operation?.error ?? snapshot.error ?? "No repositories available.",
                group: "Projects",
                disabled: true,
                onSelect: () => {},
              },
            ]
          : []),
      ],
    },
  };

  return { browse, pages };
}
