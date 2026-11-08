"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRuntimeConfig } from "@/components/runtime-config-provider";
import type {
  CommandPaletteAction,
  CommandPalettePage,
} from "@/components/terminal/CommandPalette";
import { useWindowCreationPages } from "@/hooks/useWindowCreationPages";
import type { CoderWorkspace } from "@/lib/coder/types";
import { discoveryOptions } from "@/lib/discovery/queries";
import { isDiscoveryDenied } from "@/lib/discovery/types";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import { workspaceTemplateCapabilities } from "@/lib/templates/catalog";
import { matchesProjectSearch } from "@/lib/terminal/command-search";
import { registerGlobalCommandPaletteSource } from "@/lib/terminal/global-command-palette";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";
import { repositories, repositoryTerminalPane } from "@/lib/workspaces/terminal-selection";

const NO_TEMPLATES: string[] = [];

export function useGeneralWorkspaceCommands({
  workspaces,
  onOpenPane,
  onError,
  onStart,
  initialWorkspaceId,
  additionalActions,
}: {
  workspaces: CoderWorkspace[];
  onOpenPane: (pane: GeneralPane) => void;
  onError: (message: string) => void;
  onStart: (workspaceId: string) => Promise<void>;
  initialWorkspaceId?: string;
  additionalActions?: CommandPaletteAction[];
}) {
  const { workspaceCapabilities } = useRuntimeConfig();
  const portable = workspaceCapabilities !== undefined;
  const terminalEnabled = !portable || workspaceCapabilities.terminalEnabled;
  const readTemplates = workspaceCapabilities?.readTemplateIds ?? NO_TEMPLATES;
  const projectTemplates = workspaceCapabilities?.projectTemplateIds ?? NO_TEMPLATES;
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { pages: creationPages, beginCreation } = useWindowCreationPages({
    workspaces,
    initialWorkspaceId,
    open,
    onOpenPane,
    allowProjectClone: !portable,
    allowTerminalCreation: terminalEnabled,
  });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ workspaceId: string; message: string } | null>(
    null,
  );
  // Polling returns new workspace objects. Rediscover only when the running builds change or search opens.
  const targets = JSON.stringify(
    workspaces
      .filter((w) => w.latest_build.status === "running")
      .map((w) => [w.id, w.latest_build.id, w.template_id ?? null])
      .sort(),
  );
  const selected = useMemo(
    () =>
      (JSON.parse(targets) as [string, string, string | null][]).map(
        ([workspaceId, buildId, templateId]) => ({
          workspaceId,
          buildId,
          templateId,
        }),
      ),
    [targets],
  );
  const sessions = useQueries({
    queries: selected.map((target) => ({
      ...discoveryOptions("sessions", target),
      enabled:
        open &&
        (!portable || Boolean(target.templateId && readTemplates.includes(target.templateId))),
      refetchInterval:
        open &&
        (!portable || Boolean(target.templateId && readTemplates.includes(target.templateId)))
          ? 5_000
          : (false as const),
    })),
    combine: (results) => results.map(({ data, error, isPending }) => ({ data, error, isPending })),
  });
  const clones = useQueries({
    queries: selected.map((target) => ({
      ...discoveryOptions("repositories", target),
      enabled: open && !portable,
      refetchInterval: open && !portable ? 60_000 : (false as const),
    })),
    combine: (results) => results.map(({ data, error, isPending }) => ({ data, error, isPending })),
  });
  const loading =
    open &&
    selected.some(
      (target, index) =>
        ((!portable || Boolean(target.templateId && readTemplates.includes(target.templateId))) &&
          sessions[index].isPending) ||
        (!portable && clones[index].isPending),
    );
  const data = useMemo(
    () =>
      selected.map((target, index) => {
        const denied = (
          portable ? [sessions[index].error] : [sessions[index].error, clones[index].error]
        ).some(isDiscoveryDenied);
        const readConfigured =
          !portable || Boolean(target.templateId && readTemplates.includes(target.templateId));
        return {
          workspaceId: target.workspaceId,
          sessions:
            !readConfigured || denied
              ? []
              : (sessions[index].data ?? [])
                  .map((session) => session.name)
                  .filter((name) => !isCloneTerminalSessionName(name)),
          repositories: portable || denied ? [] : repositories(clones[index].data?.nodes ?? []),
          readConfigured,
          error:
            (readConfigured && sessions[index].error) || (!portable && clones[index].error)
              ? portable
                ? "Could not refresh terminals. Review workspace setup or retry."
                : "Could not refresh some results. Previously loaded results are still shown. Retry to update them."
              : undefined,
        };
      }),
    [selected, sessions, clones, portable, readTemplates],
  );

  const retryWorkspace = useCallback(
    (workspaceId: string) => {
      const target = selected.find((item) => item.workspaceId === workspaceId);
      if (!target) return;
      if (portable && (!target.templateId || !readTemplates.includes(target.templateId))) return;
      for (const resource of portable
        ? (["sessions"] as const)
        : (["sessions", "repositories"] as const)) {
        void client
          .fetchQuery({
            ...discoveryOptions(resource, target, true),
            staleTime: 0,
          })
          .catch(() => {});
      }
    },
    [client, selected, portable, readTemplates],
  );

  const run = useCallback(
    async (operation: () => Promise<GeneralPane>) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      try {
        onOpenPane(await operation());
      } catch (error) {
        onError(error instanceof Error ? error.message : "Could not open terminal.");
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [onOpenPane, onError],
  );

  const startWorkspace = useCallback(
    async (workspaceId: string) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setStarting(workspaceId);
      setStartError(null);
      try {
        await onStart(workspaceId);
      } catch (error) {
        setStartError({
          workspaceId,
          message: error instanceof Error ? error.message : "Could not start workspace.",
        });
      } finally {
        pending.current = false;
        setBusy(false);
        setStarting(null);
      }
    },
    [onStart],
  );

  const actions = useMemo<CommandPaletteAction[]>(() => {
    const resultsByWorkspace = workspaces.flatMap<CommandPaletteAction>((workspace) => {
      const status = workspace.latest_build.status;
      const capabilities = workspaceTemplateCapabilities(workspace.template_name ?? "");
      const apps = [
        {
          tool: "files",
          label: "Files",
          aliases: ["file browser", "file manager"],
          available: capabilities.fileBrowser,
        },
        {
          tool: "code",
          label: "VS Code",
          aliases: ["vscode", "editor", "code editor"],
          available: capabilities.editor,
        },
        {
          tool: "desktop",
          label: "Desktop",
          aliases: ["remote desktop"],
          available: capabilities.desktop,
        },
      ] as const;
      if (status !== "running") {
        const availableApps = apps.filter((app) => app.available);
        const available = availableApps.map((app) => app.label);
        const error = startError?.workspaceId === workspace.id ? startError.message : null;
        return [
          {
            id: `start-workspace:${workspace.id}`,
            label: `${status === "stopped" ? "Start" : "Workspace"} ${workspace.name}`,
            description:
              error ??
              `${status} · Terminals, repositories${available.length ? `, ${available.join(", ")}` : ""}`,
            group: "Workspaces",
            aliases: availableApps.flatMap<string>((app) => app.aliases),
            value: `${workspace.name} ${status} start workspace terminals repositories agents ${available.join(" ")}`,
            rightLabel: starting === workspace.id ? "Starting…" : status,
            icon: "terminal",
            disabled: busy || status !== "stopped",
            closeOnSelect: false,
            onSelect: () => {
              void startWorkspace(workspace.id);
            },
          },
        ];
      }
      const found = data.find((entry) => entry.workspaceId === workspace.id);
      const results: CommandPaletteAction[] = [];
      for (const repository of found?.repositories ?? []) {
        if (matchesProjectSearch(repository.label, repository.relativePath, query))
          results.push({
            id: `repository:${workspace.id}:${repository.cloneSessionKey}`,
            label: repository.label,
            description: `${workspace.name} · ${repository.relativePath}`,
            group: "Projects",
            value: `${repository.label} ${repository.relativePath} ${workspace.name}`,
            rightLabel: "Open terminal",
            icon: "terminal",
            disabled: busy,
            onSelect: () => {
              void run(() => repositoryTerminalPane(workspace.id, repository));
            },
          });
        for (const app of apps) {
          if (!app.available || app.tool === "desktop") continue;
          results.push({
            id: `project-app:${workspace.id}:${app.tool}:${repository.cloneSessionKey}`,
            label: `${app.label} · ${repository.label}`,
            description: `${workspace.name} · ${repository.relativePath}`,
            group: app.label,
            value: `${app.label} ${repository.label} ${repository.relativePath} ${workspace.name}`,
            icon: app.tool,
            disabled: busy,
            onSelect: () =>
              onOpenPane({
                kind: "app",
                workspaceId: workspace.id,
                tool: app.tool,
                projectPath: repository.relativePath,
                label: `${app.label} · ${repository.label}`,
              }),
          });
        }
        results.push({
          id: `project-logs:${workspace.id}:${repository.cloneSessionKey}`,
          label: `Logs · ${repository.label}`,
          description: `${workspace.name} · ${repository.relativePath}`,
          group: "Logs",
          value: `logs events ${repository.label} ${repository.relativePath} ${workspace.name}`,
          icon: "search",
          disabled: busy,
          onSelect: () => {
            void run(async () => {
              const terminal = await repositoryTerminalPane(workspace.id, repository);
              if (terminal.kind !== "terminal") throw new Error("Project terminal is unavailable.");
              return {
                kind: "hive",
                tool: "logs",
                label: "Logs",
                workspaceId: workspace.id,
                sessionName: terminal.sessionName,
              };
            });
          },
        });
      }
      for (const sessionName of found?.sessions ?? []) {
        results.push({
          id: `session:${workspace.id}:${sessionName}`,
          label: sessionName,
          description: workspace.name,
          group: "Terminals",
          value: `${sessionName} ${workspace.name}`,
          rightLabel: terminalEnabled ? "Open" : "Setup",
          icon: "terminal",
          disabled: busy,
          onSelect: () =>
            terminalEnabled
              ? onOpenPane({
                  kind: "terminal",
                  workspaceId: workspace.id,
                  sessionName,
                  label: sessionName,
                })
              : { page: "terminal-capability" },
        });
      }
      for (const app of apps) {
        if (!app.available) continue;
        results.push({
          id: `app:${workspace.id}:${app.tool}`,
          label: app.label,
          aliases: app.aliases,
          description: workspace.name,
          group: app.label === "Desktop" ? "Desktops" : app.label,
          value: `${app.label} ${workspace.name} ${app.tool} app`,
          icon: app.tool,
          disabled: busy,
          onSelect: () =>
            onOpenPane({
              kind: "app",
              workspaceId: workspace.id,
              tool: app.tool,
              label: app.label,
            }),
        });
      }
      if (portable && !found?.readConfigured)
        results.push({
          id: `terminal-setup:${workspace.id}`,
          label: `Terminal discovery · ${workspace.name}`,
          description:
            "Session listing is not configured for this workspace. Review its template and Hive configuration.",
          group: "Terminals",
          icon: "search",
          onSelect: () =>
            onOpenPane({
              kind: "hive",
              tool: "templates",
              workspaceId: workspace.id,
              label: "Templates",
            }),
        });
      if (found?.error)
        results.push({
          id: `retry-terminals:${workspace.id}`,
          label: `Retry terminals in ${workspace.name}`,
          description: found.error,
          group: "Terminals",
          value: portable
            ? `retry terminals ${workspace.name}`
            : `retry terminals repositories ${workspace.name}`,
          icon: "search",
          closeOnSelect: false,
          onSelect: () => {
            retryWorkspace(workspace.id);
          },
        });
      if (portable && found?.error)
        results.push({
          id: `terminal-review:${workspace.id}`,
          label: `Review terminal setup · ${workspace.name}`,
          description: "Check this workspace's template and current Hive configuration.",
          group: "Terminals",
          icon: "search",
          onSelect: () =>
            onOpenPane({
              kind: "hive",
              tool: "templates",
              workspaceId: workspace.id,
              label: "Templates",
            }),
        });
      return results;
    });
    return [
      {
        id: "new-terminal",
        label: "Create terminal",
        aliases: ["new terminal", "create terminal", "create session", "shell"],
        group: "Terminals",
        value: "new session terminal",
        icon: "plus",
        disabled: busy,
        description: terminalEnabled
          ? "Open a named terminal session"
          : "Terminal connections are not enabled in this Hive preview. Review setup before connecting.",
        onSelect: () =>
          terminalEnabled ? beginCreation("terminal") : { page: "terminal-capability" },
      },
      ...resultsByWorkspace.filter((action) => action.group === "Terminals"),
      {
        id: "new-project",
        label: portable ? "Browse GitHub projects" : "New project",
        aliases: portable
          ? ["repositories", "github", "open project"]
          : ["clone repository", "new repository", "create project", "clone"],
        description: portable
          ? "Choose a connected repository; checkout begins only when a task starts"
          : "Clone a GitHub organization/repository",
        group: "Projects",
        value: "new project clone github repository",
        icon: "plus",
        disabled: busy,
        onSelect: () => {
          if (!portable) return beginCreation("project");
          const selected =
            workspaces.find(
              (w) =>
                w.id === initialWorkspaceId &&
                w.latest_build.status === "running" &&
                projectTemplates.includes(w.template_id),
            ) ??
            workspaces.find(
              (w) =>
                w.latest_build.status === "running" && projectTemplates.includes(w.template_id),
            );
          onOpenPane({
            kind: "hive",
            tool: "projects",
            label: "Projects",
            ...(selected ? { workspaceId: selected.id } : {}),
          });
        },
      },
      ...resultsByWorkspace.filter((action) => action.group === "Projects"),
      ...resultsByWorkspace.filter(
        (action) => action.group !== "Terminals" && action.group !== "Projects",
      ),
    ];
  }, [
    data,
    query,
    workspaces,
    busy,
    run,
    onOpenPane,
    starting,
    startError,
    startWorkspace,
    retryWorkspace,
    beginCreation,
    portable,
    terminalEnabled,
    projectTemplates,
    initialWorkspaceId,
  ]);

  const pages = useMemo<Record<string, CommandPalettePage>>(
    () => ({
      ...creationPages,
      "terminal-capability": {
        title: "Terminal setup",
        searchPlaceholder: "Terminal connections are not enabled for this Hive preview",
        actions: [
          {
            id: "terminal-enrollment",
            label: "Terminal connections need deployment enrollment",
            description:
              "The operator must enable the existing terminal relay. Updating a workspace alone does not enable it.",
            group: "Status",
            disabled: true,
            onSelect: () => {},
          },
          {
            id: "terminal-workspaces",
            label: "Manage Coder workspaces",
            group: "Setup",
            onSelect: () =>
              onOpenPane({ kind: "hive", tool: "workspaces", label: "Coder workspaces" }),
          },
          {
            id: "terminal-templates",
            label: "Review workspace templates",
            description:
              "Listing existing sessions also requires workspace support to be configured.",
            group: "Setup",
            onSelect: () => onOpenPane({ kind: "hive", tool: "templates", label: "Templates" }),
          },
        ],
      },
    }),
    [creationPages, onOpenPane],
  );

  useEffect(
    () =>
      registerGlobalCommandPaletteSource({
        id: "general-workspace",
        handlesWorkspaces: true,
        pages,
        actions: [...actions, ...(additionalActions ?? [])],
        searchValue: query,
        onSearchValueChange: setQuery,
        onOpenChange: setOpen,
        searchPlaceholder: "Search Hive…",
        emptyText: "No matching windows or commands.",
        loadingText: loading
          ? portable
            ? "Loading terminals…"
            : "Loading terminals and repositories…"
          : undefined,
      }),
    [actions, query, loading, additionalActions, pages, portable],
  );
}
