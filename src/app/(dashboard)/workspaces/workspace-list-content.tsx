"use client";

import {
  AlertCircle,
  Loader2,
  Monitor,
  Play,
  Plus,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { DashboardPageShell } from "@/components/dashboard-page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CardStack,
  ListCard,
  ListCardAction,
  ListCardActions,
  ListCardHeader,
  ListCardMeta,
  ListCardMetaBadge,
  ListCardRow,
  ListCardRows,
  ListCardTitle,
} from "@/components/ui/list-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRegisterKeybinding } from "@/hooks/useKeybindings";
import {
  createWorkspaceAction,
  deleteWorkspaceAction,
  listWorkspaceTemplatesAction,
  startWorkspaceAction,
  stopWorkspaceAction,
} from "@/lib/actions/workspaces";
import type { CoderWorkspace, WorkspaceBuildStatus } from "@/lib/coder/types";
import { formatRelativeDate, statusVariant } from "@/lib/helpers/format";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { WORKSPACE_PROFILES, workspaceProfileForTemplate } from "@/lib/workspaces/profiles";

interface WorkspaceListContentProps {
  workspaces: CoderWorkspace[];
  error?: string | null;
  launchOnMount?: boolean;
}

interface WorkspaceTemplateOption {
  id: string;
  name: string;
  activeVersionId: string;
  updatedAt: string;
}

type WorkspaceOperation = "start" | "stop" | "delete";

interface PendingWorkspaceOperation {
  workspaceId: string;
  operation: WorkspaceOperation;
}

function isWorkspaceTemplateOption(value: unknown): value is WorkspaceTemplateOption {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "activeVersionId" in value &&
    typeof value.activeVersionId === "string" &&
    "updatedAt" in value &&
    typeof value.updatedAt === "string"
  );
}

function terminalHref(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/terminal/workspace`;
}

function fieldOrUnknown(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "Unknown";
}

function firstValidationMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstValidationMessage(item);
      if (message) return message;
    }
    return null;
  }

  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      const message = firstValidationMessage(item);
      if (message) return message;
    }
  }

  return null;
}

function actionErrorMessage(result: unknown, fallback: string): string {
  if (typeof result !== "object" || result === null) return fallback;
  if ("serverError" in result && typeof result.serverError === "string") {
    return result.serverError;
  }
  if ("validationErrors" in result) {
    return firstValidationMessage(result.validationErrors) ?? fallback;
  }
  return fallback;
}

function templateLabel(workspace: CoderWorkspace): string {
  return (
    workspace.template_display_name?.trim() ||
    workspace.template_name?.trim() ||
    workspace.template_id?.trim() ||
    "Unknown"
  );
}

function workspaceProfile(workspace: CoderWorkspace) {
  return workspaceProfileForTemplate(
    workspace.template_name || workspace.template_display_name || workspace.template_id,
  );
}

function lastUsedLabel(value: string | undefined): string {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  return formatRelativeDate(value);
}

const CREATE_WORKSPACE_SHORTCUT_KEYS = ["ctrl+alt+n", "cmd+alt+n"] as const;

function healthLabel(workspace: CoderWorkspace): string {
  if (!workspace.health) return "Unknown";
  return workspace.health.healthy ? "Healthy" : "Unhealthy";
}

function workspaceStatus(workspace: CoderWorkspace): string {
  return workspace.latest_build.status;
}

const NON_DELETABLE_STATUSES = new Set<WorkspaceBuildStatus>([
  "pending",
  "starting",
  "stopping",
  "deleting",
  "deleted",
  "canceling",
]);

function operationIsPending(
  pendingOperation: PendingWorkspaceOperation | null,
  workspaceId: string,
  operation: WorkspaceOperation,
): boolean {
  return pendingOperation?.workspaceId === workspaceId && pendingOperation.operation === operation;
}

function WorkspaceStatusBadge({ workspace }: { workspace: CoderWorkspace }) {
  const status = workspaceStatus(workspace);

  return <Badge variant={statusVariant[status] ?? "secondary"}>{status}</Badge>;
}

interface WorkspaceListCardProps {
  workspace: CoderWorkspace;
  pendingOperation: PendingWorkspaceOperation | null;
  onStart: (workspace: CoderWorkspace) => void;
  onStop: (workspace: CoderWorkspace) => void;
  onDelete: (workspace: CoderWorkspace) => void;
}

function WorkspaceListCard({
  workspace,
  pendingOperation,
  onStart,
  onStop,
  onDelete,
}: WorkspaceListCardProps) {
  const status = workspaceStatus(workspace);
  const href = terminalHref(workspace.id);
  const workspaceName = fieldOrUnknown(workspace.name);
  const anyOperationPending = pendingOperation !== null;
  const profile = workspaceProfile(workspace);

  return (
    <ListCard data-testid="workspace-mobile-card">
      <ListCardHeader>
        <ListCardTitle>
          <span className="break-words text-foreground">{workspaceName}</span>
        </ListCardTitle>
        <ListCardMeta>
          <ListCardMetaBadge variant={statusVariant[status] ?? "secondary"}>
            {status}
          </ListCardMetaBadge>
          <span>{lastUsedLabel(workspace.last_used_at)}</span>
        </ListCardMeta>
      </ListCardHeader>
      <ListCardRows>
        <ListCardRow label="Profile">{profile.label}</ListCardRow>
        <ListCardRow label="Template">{templateLabel(workspace)}</ListCardRow>
        <ListCardRow label="Owner">{fieldOrUnknown(workspace.owner_name)}</ListCardRow>
        <ListCardRow label="Last used">{lastUsedLabel(workspace.last_used_at)}</ListCardRow>
        <ListCardRow label="Health">{healthLabel(workspace)}</ListCardRow>
      </ListCardRows>
      <ListCardActions>
        {status === "running" ? (
          <ListCardAction as={Link} href={href} aria-label={`Open workspace for ${workspaceName}`}>
            <TerminalSquare className="h-4 w-4" aria-hidden="true" />
            Open workspace
          </ListCardAction>
        ) : null}
        {status === "stopped" ? (
          <ListCardAction
            type="button"
            onClick={() => onStart(workspace)}
            disabled={anyOperationPending}
            aria-label={`Start workspace ${workspaceName}`}
          >
            {operationIsPending(pendingOperation, workspace.id, "start") ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
            Start
          </ListCardAction>
        ) : null}
        {status === "running" ? (
          <ListCardAction
            type="button"
            onClick={() => onStop(workspace)}
            disabled={anyOperationPending}
            aria-label={`Stop workspace ${workspaceName}`}
          >
            {operationIsPending(pendingOperation, workspace.id, "stop") ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Square aria-hidden="true" />
            )}
            Stop
          </ListCardAction>
        ) : null}
        {!NON_DELETABLE_STATUSES.has(workspace.latest_build.status) ? (
          <ListCardAction
            type="button"
            onClick={() => onDelete(workspace)}
            disabled={anyOperationPending}
            className="text-destructive"
            aria-label={`Delete workspace ${workspaceName}`}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </ListCardAction>
        ) : null}
      </ListCardActions>
    </ListCard>
  );
}

export function WorkspaceListContent({
  workspaces,
  error,
  launchOnMount = false,
}: WorkspaceListContentProps) {
  const hasError = Boolean(error);
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(launchOnMount);
  const [templates, setTemplates] = useState<WorkspaceTemplateOption[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingWorkspaceOperation | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CoderWorkspace | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [, startRefreshTransition] = useTransition();

  const profileGroups = useMemo(
    () =>
      WORKSPACE_PROFILES.map((profile) => ({
        profile,
        templates: templates.filter(
          (template) => workspaceProfileForTemplate(template.name).id === profile.id,
        ),
      })).filter(({ templates: profileTemplates }) => profileTemplates.length > 0),
    [templates],
  );
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId) ?? null,
    [templateId, templates],
  );
  const selectedProfile = selectedTemplate
    ? workspaceProfileForTemplate(selectedTemplate.name)
    : null;

  const openCreateDialog = useCallback(() => {
    setCreateOpen(true);
  }, []);

  useRegisterKeybinding({
    id: "workspace:create",
    keys: [...CREATE_WORKSPACE_SHORTCUT_KEYS],
    action: () => {
      openCreateDialog();
      return false;
    },
    description: "Create workspace",
    category: "workspace",
    enabledInBrowser: true,
    global: true,
  });

  useEffect(() => {
    if (!createOpen || templates.length > 0) return;

    let cancelled = false;
    setTemplatesLoading(true);
    setTemplatesError(null);

    async function loadTemplates() {
      try {
        const result = await listWorkspaceTemplatesAction();
        if (cancelled) return;
        const parsed = Array.isArray(result?.data)
          ? result.data.filter(isWorkspaceTemplateOption)
          : [];
        setTemplates(parsed);
        setTemplateId((currentTemplateId) => currentTemplateId || parsed[0]?.id || "");
        if (result?.serverError) {
          setTemplatesError(result.serverError);
        }
      } catch (err) {
        if (!cancelled) {
          setTemplatesError(err instanceof Error ? err.message : "Failed to load templates");
        }
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    }

    void loadTemplates();

    return () => {
      cancelled = true;
    };
  }, [createOpen, templates.length]);

  const handleCreateWorkspace = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreateError(null);

      const trimmedName = workspaceName.trim();
      if (!trimmedName) {
        setCreateError("Workspace name is required.");
        return;
      }
      if (!templateId) {
        setCreateError("Choose a template before creating a workspace.");
        return;
      }

      setCreating(true);
      try {
        const result = await createWorkspaceAction({ templateId, name: trimmedName });
        if (result?.serverError || result?.validationErrors || !result?.data) {
          setCreateError(actionErrorMessage(result, "Failed to create workspace."));
          return;
        }
        setWorkspaceName("");
        setCreateOpen(false);
        startRefreshTransition(() => router.refresh());
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : "Failed to create workspace.");
      } finally {
        setCreating(false);
      }
    },
    [router, templateId, workspaceName],
  );

  const runWorkspaceOperation = useCallback(
    async (workspace: CoderWorkspace, operation: Exclude<WorkspaceOperation, "delete">) => {
      setLifecycleError(null);
      setPendingOperation({ workspaceId: workspace.id, operation });

      try {
        const result =
          operation === "start"
            ? await startWorkspaceAction({ workspaceId: workspace.id })
            : await stopWorkspaceAction({ workspaceId: workspace.id });
        if (result?.serverError || result?.validationErrors || !result?.data) {
          setLifecycleError(
            actionErrorMessage(result, `Failed to ${operation} workspace ${workspace.name}.`),
          );
          return;
        }
        startRefreshTransition(() => router.refresh());
      } catch (err) {
        setLifecycleError(
          err instanceof Error
            ? err.message
            : `Failed to ${operation} workspace ${workspace.name}.`,
        );
      } finally {
        setPendingOperation(null);
      }
    },
    [router],
  );

  const openDeleteDialog = useCallback((workspace: CoderWorkspace) => {
    setLifecycleError(null);
    setDeleteConfirmation("");
    setDeleteTarget(workspace);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setLifecycleError(null);
    setDeleteTarget(null);
    setDeleteConfirmation("");
  }, []);

  const handleDeleteWorkspace = useCallback(async () => {
    if (!deleteTarget || deleteConfirmation !== deleteTarget.name) return;

    setLifecycleError(null);
    setPendingOperation({ workspaceId: deleteTarget.id, operation: "delete" });
    try {
      const result = await deleteWorkspaceAction({
        workspaceId: deleteTarget.id,
        confirmationName: deleteConfirmation,
      });
      if (result?.serverError || result?.validationErrors || !result?.data) {
        setLifecycleError(
          actionErrorMessage(result, `Failed to delete workspace ${deleteTarget.name}.`),
        );
        return;
      }
      closeDeleteDialog();
      startRefreshTransition(() => router.refresh());
    } catch (err) {
      setLifecycleError(
        err instanceof Error ? err.message : `Failed to delete workspace ${deleteTarget.name}.`,
      );
    } finally {
      setPendingOperation(null);
    }
  }, [closeDeleteDialog, deleteConfirmation, deleteTarget, router]);

  return (
    <DashboardPageShell>
      <DashboardPageHeader
        title="Workspaces"
        description="Interactive, persistent environments organized by use case. Open one to resume its TUI sessions."
        actions={
          <Button
            type="button"
            size="sm"
            onClick={openCreateDialog}
            data-testid="open-create-workspace-modal"
          >
            <Plus data-icon="inline-start" />
            Launch workspace
            <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">
              {formatShortcut(CREATE_WORKSPACE_SHORTCUT_KEYS)}
            </span>
          </Button>
        }
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent data-testid="create-workspace-modal">
          <DialogHeader>
            <DialogTitle>Launch workspace</DialogTitle>
            <DialogDescription>
              Choose a use-case profile backed by an available Coder template. Creation starts
              immediately and remains visible in this list.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreateWorkspace}>
            <div className="space-y-2">
              <label htmlFor="workspace-name" className="text-sm font-medium">
                Workspace name
              </label>
              <Input
                id="workspace-name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="my-workspace"
                autoComplete="off"
                data-testid="create-workspace-name"
              />
              <p className="text-xs text-muted-foreground">
                Use letters, numbers, dots, underscores, or hyphens.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="workspace-template" className="text-sm font-medium">
                Workspace profile
              </label>
              <select
                id="workspace-template"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                disabled={templatesLoading || templates.length === 0}
                className="h-9 w-full rounded-lg border border-input bg-background px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                data-testid="create-workspace-template"
              >
                {templates.length === 0 ? <option value="">No templates loaded</option> : null}
                {profileGroups.map(({ profile, templates: profileTemplates }) => (
                  <optgroup key={profile.id} label={profile.label}>
                    {profileTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {selectedProfile && selectedTemplate ? (
                <div
                  className="rounded-md border border-border bg-muted/40 p-3"
                  data-testid="selected-workspace-profile"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{selectedProfile.label}</Badge>
                    <span className="text-xs text-muted-foreground">{selectedTemplate.name}</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {selectedProfile.description}
                  </p>
                </div>
              ) : null}
              {templatesLoading ? (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Loading templates…
                </p>
              ) : null}
              {templatesError ? (
                <p
                  className="text-xs text-destructive"
                  data-testid="create-workspace-template-error"
                >
                  {templatesError}
                </p>
              ) : null}
            </div>

            {createError ? (
              <Alert variant="destructive" data-testid="create-workspace-error">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Could not create workspace</AlertTitle>
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={creating || templatesLoading || !templateId}
                data-testid="submit-create-workspace"
              >
                {creating ? "Launching…" : "Launch workspace"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && pendingOperation?.operation !== "delete") closeDeleteDialog();
        }}
      >
        <DialogContent data-testid="delete-workspace-modal">
          <DialogHeader>
            <DialogTitle>Delete workspace</DialogTitle>
            <DialogDescription>
              This permanently removes the Coder workspace and any persistent resources owned by its
              template. Stop and preserve any work you need first.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="delete-workspace-confirmation" className="text-sm font-medium">
                  Type <span className="font-mono">{deleteTarget.name}</span> to confirm
                </label>
                <Input
                  id="delete-workspace-confirmation"
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  autoComplete="off"
                  disabled={pendingOperation?.operation === "delete"}
                  data-testid="delete-workspace-confirmation"
                />
              </div>
              {lifecycleError ? (
                <Alert variant="destructive" data-testid="delete-workspace-error">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Could not delete workspace</AlertTitle>
                  <AlertDescription>{lifecycleError}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDeleteDialog}
                  disabled={pendingOperation?.operation === "delete"}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void handleDeleteWorkspace()}
                  disabled={
                    deleteConfirmation !== deleteTarget.name ||
                    pendingOperation?.operation === "delete"
                  }
                  data-testid="confirm-delete-workspace"
                >
                  {pendingOperation?.operation === "delete" ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <Trash2 data-icon="inline-start" />
                  )}
                  {pendingOperation?.operation === "delete" ? "Deleting…" : "Delete workspace"}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {lifecycleError && !deleteTarget ? (
        <Alert variant="destructive" data-testid="workspace-lifecycle-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Workspace action failed</AlertTitle>
          <AlertDescription>{lifecycleError}</AlertDescription>
        </Alert>
      ) : null}

      {hasError ? (
        <Alert variant="destructive" data-testid="workspaces-error-state">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Unable to load workspaces</AlertTitle>
          <AlertDescription>
            {error ?? "Failed to fetch workspaces"}. Pull down to refresh and try again.
          </AlertDescription>
        </Alert>
      ) : workspaces.length === 0 ? (
        <Card data-testid="workspaces-empty-state">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Monitor className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-muted-foreground text-lg">No workspaces found.</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Launch a profile to start persistent, interactive terminal sessions.
            </p>
            <Button type="button" className="mt-4" onClick={openCreateDialog}>
              <Plus data-icon="inline-start" />
              Launch workspace
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <CardStack aria-label="Workspaces" data-testid="workspaces-mobile-card-stack">
            {workspaces.map((workspace) => (
              <WorkspaceListCard
                key={workspace.id}
                workspace={workspace}
                pendingOperation={pendingOperation}
                onStart={(selectedWorkspace) =>
                  void runWorkspaceOperation(selectedWorkspace, "start")
                }
                onStop={(selectedWorkspace) =>
                  void runWorkspaceOperation(selectedWorkspace, "stop")
                }
                onDelete={openDeleteDialog}
              />
            ))}
          </CardStack>

          <Card className="hidden md:block" data-testid="workspaces-desktop-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Profile</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspaces.map((workspace) => (
                  <TableRow key={workspace.id}>
                    <TableCell>
                      <WorkspaceStatusBadge workspace={workspace} />
                    </TableCell>
                    <TableCell className="font-medium text-foreground">
                      {fieldOrUnknown(workspace.name)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {workspaceProfile(workspace).label}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {templateLabel(workspace)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {fieldOrUnknown(workspace.owner_name)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {lastUsedLabel(workspace.last_used_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {healthLabel(workspace)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        {workspace.latest_build.status === "running" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            nativeButton={false}
                            render={<Link href={terminalHref(workspace.id)} />}
                          >
                            <TerminalSquare data-icon="inline-start" />
                            Open
                          </Button>
                        ) : null}
                        {workspace.latest_build.status === "stopped" ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void runWorkspaceOperation(workspace, "start")}
                            disabled={pendingOperation !== null}
                            aria-label={`Start workspace ${fieldOrUnknown(workspace.name)}`}
                          >
                            {operationIsPending(pendingOperation, workspace.id, "start") ? (
                              <Loader2 data-icon="inline-start" className="animate-spin" />
                            ) : (
                              <Play data-icon="inline-start" />
                            )}
                            Start
                          </Button>
                        ) : null}
                        {workspace.latest_build.status === "running" ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void runWorkspaceOperation(workspace, "stop")}
                            disabled={pendingOperation !== null}
                            aria-label={`Stop workspace ${fieldOrUnknown(workspace.name)}`}
                          >
                            {operationIsPending(pendingOperation, workspace.id, "stop") ? (
                              <Loader2 data-icon="inline-start" className="animate-spin" />
                            ) : (
                              <Square data-icon="inline-start" />
                            )}
                            Stop
                          </Button>
                        ) : null}
                        {!NON_DELETABLE_STATUSES.has(workspace.latest_build.status) ? (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => openDeleteDialog(workspace)}
                            disabled={pendingOperation !== null}
                            aria-label={`Delete workspace ${fieldOrUnknown(workspace.name)}`}
                          >
                            <Trash2 data-icon="inline-start" />
                            Delete
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </DashboardPageShell>
  );
}
