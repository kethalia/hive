"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandPaletteAction } from "@/components/terminal/CommandPalette";
import { createSessionAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import { discoveryOptions } from "@/lib/discovery/queries";
import { isDiscoveryDenied } from "@/lib/discovery/types";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import { workspaceTemplateCapabilities } from "@/lib/templates/catalog";
import { registerGlobalCommandPaletteSource } from "@/lib/terminal/global-command-palette";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";
import {
  repositories,
  repositoryTerminalPane,
  terminalNameError,
} from "@/lib/workspaces/terminal-selection";

export function useGeneralWorkspaceCommands({
  workspaces,
  onOpenPane,
  onError,
  onStart,
  onAgents,
  additionalActions,
}: {
  workspaces: CoderWorkspace[];
  onOpenPane: (pane: GeneralPane) => void;
  onError: (message: string) => void;
  onStart: (workspaceId: string) => Promise<void>;
  onAgents: (workspaceId: string) => void;
  additionalActions?: CommandPaletteAction[];
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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
      .map((w) => [w.id, w.latest_build.id])
      .sort(),
  );
  const selected = useMemo(
    () =>
      (JSON.parse(targets) as [string, string][]).map(([workspaceId, buildId]) => ({
        workspaceId,
        buildId,
      })),
    [targets],
  );
  const sessions = useQueries({
    queries: selected.map((target) => ({
      ...discoveryOptions("sessions", target),
      enabled: open,
      refetchInterval: open ? 5_000 : (false as const),
    })),
    combine: (results) => results.map(({ data, error, isPending }) => ({ data, error, isPending })),
  });
  const clones = useQueries({
    queries: selected.map((target) => ({
      ...discoveryOptions("repositories", target),
      enabled: open,
      refetchInterval: open ? 60_000 : (false as const),
    })),
    combine: (results) => results.map(({ data, error, isPending }) => ({ data, error, isPending })),
  });
  const loading = open && [...sessions, ...clones].some((result) => result.isPending);
  const data = useMemo(
    () =>
      selected.map((target, index) => {
        const denied = [sessions[index].error, clones[index].error].some(isDiscoveryDenied);
        return {
          workspaceId: target.workspaceId,
          sessions: denied
            ? []
            : (sessions[index].data ?? [])
                .map((session) => session.name)
                .filter((name) => !isCloneTerminalSessionName(name)),
          repositories: denied ? [] : repositories(clones[index].data?.nodes ?? []),
          error:
            sessions[index].error || clones[index].error
              ? "Could not refresh some results. Previously loaded results are still shown. Retry to update them."
              : undefined,
        };
      }),
    [selected, sessions, clones],
  );

  const retryWorkspace = useCallback(
    (workspaceId: string) => {
      const target = selected.find((item) => item.workspaceId === workspaceId);
      if (!target) return;
      for (const resource of ["sessions", "repositories"] as const) {
        void client
          .fetchQuery({
            ...discoveryOptions(resource, target, true),
            staleTime: 0,
          })
          .catch(() => {});
      }
    },
    [client, selected],
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
    const name = query.trim();
    const repositoryQuery = name.toLowerCase();
    const nameError = name ? terminalNameError(name) : null;
    return workspaces.flatMap((workspace) => {
      const status = workspace.latest_build.status;
      const capabilities = workspaceTemplateCapabilities(workspace.template_name ?? "");
      const apps = [
        { tool: "files", label: "Files", available: capabilities.fileBrowser },
        { tool: "code", label: "VS Code", available: capabilities.editor },
        { tool: "desktop", label: "Desktop", available: capabilities.desktop },
      ] as const;
      if (status !== "running") {
        const available = apps.filter((app) => app.available).map((app) => app.label);
        const error = startError?.workspaceId === workspace.id ? startError.message : null;
        return [
          {
            id: `start-workspace:${workspace.id}`,
            label: `${status === "stopped" ? "Start" : "Workspace"} ${workspace.name}`,
            description:
              error ??
              `${status} · Terminals, repositories${available.length ? `, ${available.join(", ")}` : ""}`,
            group: "Workspaces",
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
        // Restrict repository results before cmdk's fuzzy ranking can match unrelated names.
        if (
          ![repository.label, repository.relativePath].some((value) =>
            value.toLowerCase().includes(repositoryQuery),
          )
        )
          continue;
        results.push({
          id: `repository:${workspace.id}:${repository.cloneSessionKey}`,
          label: repository.label,
          description: `${workspace.name} · ${repository.relativePath}`,
          group: "Repositories",
          value: `${repository.label} ${repository.relativePath} ${workspace.name}`,
          rightLabel: "Open terminal",
          icon: "terminal",
          disabled: busy,
          onSelect: () => {
            void run(() => repositoryTerminalPane(workspace.id, repository));
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
          rightLabel: "Open",
          icon: "terminal",
          disabled: busy,
          onSelect: () =>
            onOpenPane({
              kind: "terminal",
              workspaceId: workspace.id,
              sessionName,
              label: sessionName,
            }),
        });
      }
      for (const app of apps) {
        if (!app.available) continue;
        results.push({
          id: `app:${workspace.id}:${app.tool}`,
          label: app.label,
          description: workspace.name,
          group: "Apps",
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
      results.push({
        id: `agents:${workspace.id}`,
        label: "Agents",
        description: workspace.name,
        group: "Apps",
        value: `agents tools ${workspace.name}`,
        icon: "agents",
        disabled: busy,
        onSelect: () => onAgents(workspace.id),
      });
      if (!name || !found?.sessions.includes(name))
        results.push({
          id: `new-terminal:${workspace.id}`,
          label: name ? `New terminal “${name}”` : "New terminal",
          description: nameError ? `${workspace.name} · ${nameError}` : workspace.name,
          group: "Create terminal",
          value: `${name} new terminal ${workspace.name}`,
          icon: "plus",
          disabled: busy || Boolean(nameError),
          onSelect: () => {
            void run(async () => {
              if (nameError) throw new Error(nameError);
              const result = await createSessionAction({
                workspaceId: workspace.id,
                ...(name ? { sessionName: name } : {}),
              });
              if (!result?.data)
                throw new Error(result?.serverError ?? "Could not create terminal.");
              return {
                kind: "terminal",
                workspaceId: workspace.id,
                sessionName: result.data.name,
                label: result.data.name,
              };
            });
          },
        });
      if (found?.error)
        results.push({
          id: `retry-terminals:${workspace.id}`,
          label: `Retry terminals in ${workspace.name}`,
          description: found.error,
          group: "Terminals",
          value: `${name} retry ${workspace.name}`,
          icon: "search",
          closeOnSelect: false,
          onSelect: () => {
            retryWorkspace(workspace.id);
          },
        });
      return results;
    });
  }, [
    data,
    query,
    workspaces,
    busy,
    run,
    onOpenPane,
    onAgents,
    starting,
    startError,
    startWorkspace,
    retryWorkspace,
  ]);

  useEffect(
    () =>
      registerGlobalCommandPaletteSource({
        id: "general-workspace",
        handlesWorkspaces: true,
        actions: [...actions, ...(additionalActions ?? [])],
        searchValue: query,
        onSearchValueChange: setQuery,
        onOpenChange: setOpen,
        searchPlaceholder: "Search terminals, repositories, apps, and commands…",
        emptyText: "No matching windows or commands.",
        loadingText: loading ? "Loading terminals and repositories…" : undefined,
      }),
    [actions, query, loading, additionalActions],
  );
}
