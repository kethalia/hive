import { AlertCircle, Monitor, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import type { CoderWorkspace } from "@/lib/coder/types";
import { formatRelativeDate, statusVariant } from "@/lib/helpers/format";

interface WorkspaceListContentProps {
  workspaces: CoderWorkspace[];
  error?: string | null;
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Workspaces</h1>
          <p className="text-muted-foreground text-sm">
            Open a workspace terminal or pull down to refresh the current Coder list.
          </p>
        </div>
      </div>

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
