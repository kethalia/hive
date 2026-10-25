"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cloneProjectAction } from "@/lib/actions/clone-project";
import { createSessionAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";
import { terminalNameError } from "@/lib/workspaces/terminal-selection";
import { restoreWorkspaceFocus } from "@/lib/workspaces/window-focus";

export function CreateWindowDialog({
  kind,
  workspaces,
  initialWorkspaceId,
  onClose,
  onOpenPane,
}: {
  kind: "terminal" | "project";
  workspaces: CoderWorkspace[];
  initialWorkspaceId?: string;
  onClose: () => void;
  onOpenPane: (pane: GeneralPane) => void;
}) {
  const available = workspaces.filter((w) => w.latest_build.status === "running");
  const [workspaceId, setWorkspaceId] = useState(
    () =>
      available.find((w) => w.id === initialWorkspaceId)?.id ??
      available.find((w) => w.template_name === "ai-dev-k8s")?.id ??
      available[0]?.id ??
      "",
  );
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  const client = useQueryClient();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!available.some((w) => w.id === workspaceId))
        throw new Error("Choose a running Coder workspace.");
      const label = name.trim();
      if (!label)
        throw new Error(kind === "terminal" ? "Enter a session name." : "Enter a repository name.");
      let pane: GeneralPane;
      if (kind === "terminal") {
        const invalid = terminalNameError(label);
        if (invalid) throw new Error(invalid);
        const result = await createSessionAction({ workspaceId, sessionName: label });
        if (!result?.data) throw new Error(result?.serverError ?? "Could not create the session.");
        pane = {
          kind: "terminal",
          workspaceId,
          sessionName: result.data.name,
          label: result.data.name,
        };
      } else {
        const result = await cloneProjectAction({
          workspaceId,
          organization: organization.trim(),
          repository: label,
        });
        if (!result?.data)
          throw new Error(
            result?.serverError ??
              "Could not clone the project. Check the organization and repository names.",
          );
        pane = result.data;
      }
      void client.invalidateQueries({
        queryKey: ["discovery", kind === "terminal" ? "sessions" : "repositories", workspaceId],
      });
      if (!mounted.current) return;
      onOpenPane(pane);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not open the window.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
    >
      <DialogContent
        finalFocus={restoreWorkspaceFocus}
        showCloseButton={!busy}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{kind === "terminal" ? "New session" : "New project"}</DialogTitle>
          <DialogDescription>
            {kind === "terminal"
              ? "Open a named terminal in your workspace."
              : "Clone a GitHub repository and open its terminal."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={busy} className="space-y-4">
            <label className="block space-y-2 text-sm">
              Coder workspace
              <select
                className="h-10 w-full rounded-md border bg-background px-3"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {!available.length ? <option value="">No running workspaces</option> : null}
                {available.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            {kind === "project" ? (
              <label htmlFor="new-project-owner" className="block space-y-2 text-sm">
                Organization or owner
                <Input
                  id="new-project-owner"
                  autoFocus
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  placeholder="kethalia"
                  required
                  maxLength={39}
                />
              </label>
            ) : null}
            <label htmlFor="new-window-name" className="block space-y-2 text-sm">
              {kind === "terminal" ? "Session name" : "Repository"}
              <Input
                id="new-window-name"
                autoFocus={kind === "terminal"}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "terminal" ? "my-session" : "hive"}
                required
                maxLength={kind === "terminal" ? 200 : 100}
              />
            </label>
            {kind === "project" ? (
              <p className="text-xs text-muted-foreground">
                Uses GitHub authentication already configured in the selected Coder workspace.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {busy ? (
              <p role="status" className="text-sm">
                {kind === "terminal" ? "Opening session…" : "Cloning project…"}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!available.length}>
                {kind === "terminal" ? "Open session" : "Clone and open"}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
