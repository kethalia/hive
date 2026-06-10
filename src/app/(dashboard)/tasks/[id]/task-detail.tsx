"use client";

import { AlertCircle, ArrowLeft, ExternalLink, GitBranch, Paperclip } from "lucide-react";
import Link from "next/link";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useEffect, useState } from "react";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getTaskAction } from "@/lib/actions/tasks";
import { isCouncilReport } from "@/lib/council/types";
import { formatTimestamp, shortId, statusVariant } from "@/lib/helpers/format";
import type { TaskWithRelations } from "@/lib/types/tasks";
import { ACTIVE_STATUSES } from "@/lib/types/tasks";
import { isVerificationReport } from "@/lib/verification/types";
import { AgentStreamPanel } from "./agent-stream-panel";
import { CouncilResultCard } from "./council-result-card";
import { VerificationReportCard } from "./verification-report-card";

export function TaskDetail({ initialTask }: { initialTask: TaskWithRelations }) {
  const [task, setTask] = useState<TaskWithRelations>(initialTask);

  const { execute } = useAction(getTaskAction, {
    onSuccess: ({ data }) => {
      if (data) {
        setTask(data as TaskWithRelations);
      }
    },
  });

  const fetchTask = useCallback(() => {
    execute({ id: initialTask.id });
  }, [execute, initialTask.id]);

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(task.status)) return;

    const interval = setInterval(fetchTask, 5000);
    return () => clearInterval(interval);
  }, [task.status, fetchTask]);

  return (
    <div className="space-y-4 pb-safe sm:space-y-6">
      <DashboardPageHeader
        title={`Task ${shortId(task.id)}`}
        leading={
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            className="min-h-11 touch-manipulation sm:min-h-7"
            render={<Link href="/tasks" />}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Tasks
          </Button>
        }
        actions={<Badge variant={statusVariant[task.status] ?? "secondary"}>{task.status}</Badge>}
      />

      {/* Error alert */}
      {task.errorMessage && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{task.errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Task info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Task Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Prompt</p>
            <p className="whitespace-pre-wrap text-foreground">{task.prompt}</p>
          </div>

          <div data-testid="task-metadata-grid" className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">Repository</p>
              <a
                data-testid="task-repo-link"
                href={task.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full min-w-0 items-start gap-1 break-all font-mono text-sm text-primary hover:underline"
              >
                {task.repoUrl}
                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
              </a>
            </div>

            {task.branch && (
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">Branch</p>
                <p className="inline-flex max-w-full min-w-0 items-center gap-1 break-all font-mono text-sm text-foreground">
                  <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                  {task.branch}
                </p>
              </div>
            )}

            {task.prUrl && (
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">Pull Request</p>
                <a
                  data-testid="task-pr-link"
                  href={task.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full min-w-0 items-start gap-1 break-all text-sm text-primary hover:underline"
                >
                  {task.prUrl}
                  <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                </a>
              </div>
            )}

            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">Created</p>
              <p className="break-words text-sm">{formatTimestamp(task.createdAt)}</p>
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">Last Updated</p>
              <p className="break-words text-sm">{formatTimestamp(task.updatedAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Attachments */}
      {task.attachments && task.attachments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Attachments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {task.attachments.map((att) => (
                <li
                  key={`${att.type}-${att.name}`}
                  className="flex flex-wrap items-center gap-2 text-sm sm:gap-3"
                >
                  <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <Badge variant="outline" className="shrink-0 font-mono text-xs">
                    {att.type}
                  </Badge>
                  <span className="min-w-0 break-all">{att.name}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Verification Report */}
      {isVerificationReport(task.verificationReport) && (
        <VerificationReportCard report={task.verificationReport} />
      )}

      {/* Council Review */}
      {isCouncilReport(task.councilReport) && <CouncilResultCard report={task.councilReport} />}

      {/* Workspaces */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Workspaces
          </CardTitle>
        </CardHeader>
        <CardContent>
          {task.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">No workspaces created yet.</p>
          ) : (
            <div className="space-y-2">
              {task.workspaces.map((ws) => (
                <div
                  key={ws.id}
                  data-testid="task-workspace-row"
                  className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <code className="shrink-0 text-xs text-muted-foreground">{shortId(ws.id)}</code>
                    <span className="min-w-0 break-all text-sm">{ws.templateType}</span>
                  </div>
                  <Badge
                    className="self-start sm:self-auto"
                    variant={statusVariant[ws.status] ?? "secondary"}
                  >
                    {ws.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Logs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {task.logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No log entries yet.</p>
          ) : (
            <ScrollArea className="h-[300px]">
              <div className="space-y-1">
                {task.logs.map((log) => (
                  <div
                    key={log.id}
                    data-testid="task-log-row"
                    className="flex flex-col gap-1 py-1.5 text-sm sm:flex-row sm:items-start sm:gap-3"
                  >
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:min-w-[140px]">
                      {formatTimestamp(log.createdAt)}
                    </span>
                    <span
                      className={
                        log.level === "error"
                          ? "break-words text-destructive"
                          : "break-words text-foreground"
                      }
                    >
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Live Agent Streaming */}
      <AgentStreamPanel taskId={task.id} status={task.status} />
    </div>
  );
}
