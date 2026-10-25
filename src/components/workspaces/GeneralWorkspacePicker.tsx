"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { listGitClonesAction, resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import { createSessionAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { CloneTreeNode, CloneTreeRepositoryNode } from "@/lib/git/clone-tree";
import { workspaceTemplateCapabilities } from "@/lib/templates/catalog";
import type { GeneralPane, GeneralWorkspaceTool } from "@/lib/workspaces/general-workspace";

function repositories(nodes: readonly CloneTreeNode[]): CloneTreeRepositoryNode[] {
  return nodes.flatMap((node) =>
    node.kind === "repository" ? [node] : repositories(node.children),
  );
}
interface Props {
  open: boolean;
  workspaceId?: string;
  workspaces: CoderWorkspace[];
  onOpenChange: (open: boolean) => void;
  onOpenPane: (pane: GeneralPane) => void;
  onOpenTool: (workspaceId: string, tool: GeneralWorkspaceTool) => void;
  onStart: (workspaceId: string) => Promise<void>;
  onAgents: (workspaceId: string) => void;
}
export function GeneralWorkspacePicker({
  open,
  workspaceId,
  workspaces,
  onOpenChange,
  onOpenPane,
  onOpenTool,
  onStart,
  onAgents,
}: Props) {
  const [selected, setSelected] = useState(workspaceId ?? "");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{
    workspaceId: string;
    sessions: string[];
    repositories: CloneTreeRepositoryNode[];
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (open) {
      setSelected(workspaceId ?? "");
      setError(null);
      setQuery("");
    }
  }, [open, workspaceId]);
  const workspace = workspaces.find((item) => item.id === selected);
  const running = workspace?.latest_build.status === "running";
  const capabilities = workspaceTemplateCapabilities(workspace?.template_name ?? "");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and build changes refresh session discovery.
  useEffect(() => {
    if (!open || !selected || !running) return;
    let cancelled = false;
    setData(null);
    void Promise.allSettled([
      getWorkspaceSessionsAction({ workspaceId: selected }),
      listGitClonesAction({ workspaceId: selected }),
    ]).then(([sessions, clones]) => {
      if (cancelled) return;
      const sessionData = sessions.status === "fulfilled" ? sessions.value?.data : undefined;
      const cloneData = clones.status === "fulfilled" ? clones.value?.data : undefined;
      setData({
        workspaceId: selected,
        sessions: sessionData?.map((session) => session.name) ?? [],
        repositories: cloneData?.ok ? repositories(cloneData.tree.nodes) : [],
        error:
          !sessionData || !cloneData?.ok
            ? "Some terminals could not be listed. Retry to refresh the available sessions and repositories."
            : undefined,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, selected, running, workspace?.latest_build.id, retry]);
  async function openTerminal(repository?: CloneTreeRepositoryNode) {
    if (!workspace || busy) return;
    const requested = workspace.id;
    setBusy(true);
    setError(null);
    try {
      if (repository) {
        const result = await resolveGitCloneTerminalAction({
          workspaceId: requested,
          cloneSessionKey: repository.cloneSessionKey,
          relativePath: repository.relativePath,
        });
        if (!result?.data)
          throw new Error(result?.serverError ?? "Could not open repository terminal.");
        onOpenPane({
          kind: "terminal",
          workspaceId: requested,
          sessionName: result.data.sessionName,
          label: repository.label,
          cloneSessionKey: repository.cloneSessionKey,
          relativePath: repository.relativePath,
        });
      } else {
        const result = await createSessionAction({ workspaceId: requested });
        if (!result?.data) throw new Error(result?.serverError ?? "Could not create terminal.");
        onOpenPane({
          kind: "terminal",
          workspaceId: requested,
          sessionName: result.data.name,
          label: result.data.name,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open terminal.");
    } finally {
      setBusy(false);
    }
  }
  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase());
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
        data-testid="general-workspace-picker"
      >
        <DialogHeader>
          <DialogTitle>Add window</DialogTitle>
          <DialogDescription>Open a terminal or app from any Coder workspace.</DialogDescription>
        </DialogHeader>
        <label className="text-sm" htmlFor="general-workspace-source">
          Coder workspace
        </label>
        <select
          id="general-workspace-source"
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setError(null);
          }}
          className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Choose a workspace</option>
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.latest_build.status}
            </option>
          ))}
        </select>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {workspace && !running ? (
          <div className="space-y-3">
            <p className="text-sm">
              {workspace.name} is {workspace.latest_build.status}.
            </p>
            {workspace.latest_build.status === "stopped" ? (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onStart(workspace.id);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Could not start workspace.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Start workspace
              </Button>
            ) : null}
          </div>
        ) : null}
        {workspace && running ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void openTerminal()}>
                New terminal
              </Button>
              {capabilities.fileBrowser ? (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() => onOpenTool(workspace.id, "files")}
                >
                  Files
                </Button>
              ) : null}
              {capabilities.editor ? (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() => onOpenTool(workspace.id, "code")}
                >
                  VS Code
                </Button>
              ) : null}
              {capabilities.desktop ? (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() => onOpenTool(workspace.id, "desktop")}
                >
                  Desktop
                </Button>
              ) : null}
              <Button disabled={busy} variant="outline" onClick={() => onAgents(workspace.id)}>
                Agents
              </Button>
            </div>
            <Input
              aria-label="Search terminals and repositories"
              placeholder="Search terminals and repositories…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {!data || data.workspaceId !== selected ? (
              <p role="status" className="text-sm">
                Loading terminals…
              </p>
            ) : (
              <>
                {data.error ? (
                  <div role="alert" className="text-sm">
                    <p>{data.error}</p>
                    <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
                      Retry
                    </Button>
                  </div>
                ) : null}
                <section className="space-y-1">
                  <h3 className="text-xs text-muted-foreground">Existing terminals</h3>
                  {data.sessions.filter(matches).map((session) => (
                    <Button
                      key={session}
                      className="w-full justify-start truncate"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        onOpenPane({
                          kind: "terminal",
                          workspaceId: workspace.id,
                          sessionName: session,
                          label: session,
                        })
                      }
                    >
                      {session}
                    </Button>
                  ))}
                  {!data.sessions.length ? (
                    <p className="text-sm text-muted-foreground">No existing terminals.</p>
                  ) : null}
                </section>
                <section className="space-y-1">
                  <h3 className="text-xs text-muted-foreground">Repository terminals</h3>
                  {data.repositories
                    .filter((repo) => matches(repo.relativePath))
                    .map((repo) => (
                      <Button
                        key={repo.cloneSessionKey}
                        className="h-auto min-h-11 w-full justify-start whitespace-normal text-left"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void openTerminal(repo)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate">{repo.label}</span>
                          <span className="block break-all text-xs text-muted-foreground">
                            {repo.relativePath}
                          </span>
                        </span>
                      </Button>
                    ))}
                </section>
              </>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
