"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandPaletteAction } from "@/components/terminal/CommandPalette";
import { createSessionAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import { registerGlobalCommandPaletteSource } from "@/lib/terminal/global-command-palette";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";
import {
  loadWorkspaceTerminals,
  repositoryTerminalPane,
  terminalNameError,
} from "@/lib/workspaces/terminal-selection";

export function useGeneralWorkspaceCommands({
  workspaces,
  onOpenPane,
  onError,
}: {
  workspaces: CoderWorkspace[];
  onOpenPane: (pane: GeneralPane) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadWorkspaceTerminals>>[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  // Polling returns new workspace objects. Rediscover only when the running builds change or search opens.
  const targets = JSON.stringify(
    workspaces
      .filter((w) => w.latest_build.status === "running")
      .map((w) => [w.id, w.latest_build.id])
      .sort(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly refreshes discovery.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setData([]);
    const ids = (JSON.parse(targets) as [string, string][]).map(([id]) => id);
    void Promise.all(ids.map(loadWorkspaceTerminals)).then((results) => {
      if (cancelled) return;
      setData(results);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, targets, retry]);

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

  const actions = useMemo<CommandPaletteAction[]>(() => {
    const name = query.trim();
    const nameError = name ? terminalNameError(name) : null;
    return workspaces
      .filter((w) => w.latest_build.status === "running")
      .flatMap((workspace) => {
        const found = data.find((entry) => entry.workspaceId === workspace.id);
        const results: CommandPaletteAction[] = [];
        for (const repository of found?.repositories ?? []) {
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
        if (!name || !found?.sessions.includes(name))
          results.push({
            id: `new-terminal:${workspace.id}`,
            label: name ? `New terminal “${name}”` : "New terminal",
            description: nameError ?? workspace.name,
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
            onSelect: () => setRetry((value) => value + 1),
          });
        return results;
      });
  }, [data, query, workspaces, busy, run, onOpenPane]);

  useEffect(
    () =>
      registerGlobalCommandPaletteSource({
        id: "general-workspace",
        actions,
        searchValue: query,
        onSearchValueChange: setQuery,
        onOpenChange: setOpen,
        searchPlaceholder: "Search repositories, terminals, and commands…",
        emptyText: loading
          ? "Loading terminals and repositories…"
          : "No matching terminals or commands.",
      }),
    [actions, query, loading],
  );
}
