"use client";

import { AlertCircle, Loader2, Monitor, Plus, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
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
import { createWorkspaceAction, listWorkspaceTemplatesAction } from "@/lib/actions/workspaces";
import type { CoderWorkspace } from "@/lib/coder/types";
import { formatRelativeDate, statusVariant } from "@/lib/helpers/format";

interface WorkspaceListContentProps {
  workspaces: CoderWorkspace[];
  error?: string | null;
}

interface WorkspaceTemplateOption {
  id: string;
  name: string;
  activeVersionId: string;
  updatedAt: string;
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

function isTextEntryElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;

  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function terminalHref(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/terminal`;
}

function fieldOrUnknown(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "Unknown";
}

function templateLabel(workspace: CoderWorkspace): string {
  return (
    workspace.template_display_name?.trim() ||
    workspace.template_name?.trim() ||
    workspace.template_id?.trim() ||
    "Unknown"
  );
}

function lastUsedLabel(value: string | undefined): string {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  return formatRelativeDate(value);
}

function healthLabel(workspace: CoderWorkspace): string {
  if (!workspace.health) return "Unknown";
  return workspace.health.healthy ? "Healthy" : "Unhealthy";
}

function workspaceStatus(workspace: CoderWorkspace): string {
  return workspace.latest_build.status;
}

function WorkspaceStatusBadge({ workspace }: { workspace: CoderWorkspace }) {
  const status = workspaceStatus(workspace);

  return <Badge variant={statusVariant[status] ?? "secondary"}>{status}</Badge>;
}

function WorkspaceListCard({ workspace }: { workspace: CoderWorkspace }) {
  const status = workspaceStatus(workspace);
  const href = terminalHref(workspace.id);
  const workspaceName = fieldOrUnknown(workspace.name);

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
        <ListCardRow label="Template">{templateLabel(workspace)}</ListCardRow>
        <ListCardRow label="Owner">{fieldOrUnknown(workspace.owner_name)}</ListCardRow>
        <ListCardRow label="Last used">{lastUsedLabel(workspace.last_used_at)}</ListCardRow>
        <ListCardRow label="Health">{healthLabel(workspace)}</ListCardRow>
      </ListCardRows>
      <ListCardActions>
        <ListCardAction as={Link} href={href} aria-label={`Open terminal for ${workspaceName}`}>
          <TerminalSquare className="h-4 w-4" aria-hidden="true" />
          Open terminal
        </ListCardAction>
      </ListCardActions>
    </ListCard>
  );
}

export function WorkspaceListContent({ workspaces, error }: WorkspaceListContentProps) {
  const hasError = Boolean(error);
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [templates, setTemplates] = useState<WorkspaceTemplateOption[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const openCreateDialog = useCallback(() => {
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n") return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (isTextEntryElement(event.target instanceof Element ? event.target : null)) return;

      event.preventDefault();
      openCreateDialog();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [openCreateDialog]);

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
        if (!templateId && parsed[0]) {
          setTemplateId(parsed[0].id);
        }
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
  }, [createOpen, templateId, templates.length]);

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
        if (result?.serverError || !result?.data) {
          setCreateError(result?.serverError ?? "Failed to create workspace.");
          return;
        }
        setWorkspaceName("");
        setCreateOpen(false);
        router.refresh();
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : "Failed to create workspace.");
      } finally {
        setCreating(false);
      }
    },
    [router, templateId, workspaceName],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Workspaces</h1>
          <p className="text-muted-foreground text-sm">
            Open a workspace terminal or pull down to refresh the current Coder list.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={openCreateDialog}
          data-testid="open-create-workspace-modal"
        >
          <Plus data-icon="inline-start" />
          Add workspace
          <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">⌘/Ctrl N</span>
        </Button>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent data-testid="create-workspace-modal">
          <DialogHeader>
            <DialogTitle>Add workspace</DialogTitle>
            <DialogDescription>
              Create a Coder workspace from an available template. The workspace list refreshes
              after creation starts.
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
                Template
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
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
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
                {creating ? "Creating…" : "Create workspace"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
              Pull down to refresh after creating a workspace in Coder.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <CardStack aria-label="Workspaces" data-testid="workspaces-mobile-card-stack">
            {workspaces.map((workspace) => (
              <WorkspaceListCard key={workspace.id} workspace={workspace} />
            ))}
          </CardStack>

          <Card className="hidden md:block" data-testid="workspaces-desktop-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead className="text-right">Action</TableHead>
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
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        render={<Link href={terminalHref(workspace.id)} />}
                      >
                        <TerminalSquare data-icon="inline-start" />
                        Terminal
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
