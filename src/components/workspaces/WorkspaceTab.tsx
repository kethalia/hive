"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CoderWorkspace } from "@/lib/coder/types";
import { requestHiveWindow } from "@/lib/workspaces/general-workspace";

export function useWorkspaceStart(
  workspace: CoderWorkspace | undefined,
  onStart: (id: string) => Promise<void>,
) {
  const [startup, setStartup] = useState<{ id: string; pending: boolean } | null>(null);
  async function start(id: string, onSuccess?: () => void) {
    setStartup({ id, pending: true });
    try {
      await onStart(id);
      setStartup(null);
      onSuccess?.();
    } catch {
      setStartup({ id, pending: false });
    }
  }
  return {
    starting: startup?.id === workspace?.id && startup?.pending === true,
    startFailed: startup?.id === workspace?.id && startup?.pending === false,
    clear: () => setStartup(null),
    start,
  };
}

export function WorkspaceTab({
  workspaces,
  workspace,
  starting,
  startFailed,
  onSelect,
  onStart,
  onUseCurrentBuild,
}: {
  workspaces: CoderWorkspace[];
  workspace?: CoderWorkspace;
  starting: boolean;
  startFailed: boolean;
  onSelect: (workspace: CoderWorkspace) => void;
  onStart: (id: string) => void;
  onUseCurrentBuild?: () => void;
}) {
  const radioGroup = useId();
  const status = workspace?.latest_build.status;
  return (
    <div className="space-y-3">
      {workspaces.length > 0 && (
        <fieldset disabled={starting} className="min-w-0 space-y-2">
          <legend className="text-sm">Coder workspaces</legend>
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {workspaces.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50 has-checked:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring has-disabled:cursor-default"
              >
                <input
                  type="radio"
                  name={radioGroup}
                  aria-label={`${item.name}, ${item.latest_build.status}`}
                  className="shrink-0 accent-primary"
                  checked={item.id === workspace?.id}
                  onChange={() => {
                    onSelect(item);
                  }}
                />
                <span className="min-w-0 flex-1 break-all">{item.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.latest_build.status}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {starting ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          Starting {workspace?.name}…
        </p>
      ) : workspace && (status === "stopped" || startFailed) ? (
        <>
          {startFailed && (
            <p role="alert" className="text-sm text-destructive">
              Could not open {workspace.name}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(status === "stopped" || status === "running") && (
              <Button onClick={() => onStart(workspace.id)}>
                <Play aria-hidden />
                {status === "running" ? "Retry" : "Start workspace"}
              </Button>
            )}
            {startFailed && (
              <Button variant="outline" onClick={() => requestHiveWindow({ tool: "workspaces" })}>
                Coder workspaces
              </Button>
            )}
          </div>
        </>
      ) : workspace && status === "running" && onUseCurrentBuild ? (
        <>
          <p role="status">Select this workspace’s current build to manage accounts.</p>
          <Button onClick={onUseCurrentBuild}>Use current build</Button>
        </>
      ) : status !== "running" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {!workspace
            ? workspaces.length
              ? "The selected workspace is unavailable. Choose another workspace."
              : "No workspaces available."
            : status === "starting" || status === "pending"
              ? "Waiting for the workspace to start…"
              : `Workspace is ${status}. Manage it in Coder workspaces.`}
        </p>
      ) : null}
    </div>
  );
}
