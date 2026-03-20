"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { useAction } from "next-safe-action/hooks";
import { getTaskAction } from "@/lib/actions/tasks";
import type { TaskWithRelations } from "@/lib/types/tasks";
import { ACTIVE_STATUSES } from "@/lib/types/tasks";
import { shortId, formatTimestamp, statusVariant } from "@/lib/helpers/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, ArrowLeft, ExternalLink, GitBranch, Paperclip } from "lucide-react";
import { VerificationReportCard } from "./verification-report-card";
import { AgentStreamPanel } from "./agent-stream-panel";
import type { VerificationReportData } from "@/lib/types/tasks";

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
    <div className="space-y-6">
      {/* Navigation */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/tasks" />}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to Tasks
        </Button>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          Task {shortId(task.id)}
        </h1>
        <Badge variant={statusVariant[task.status] ?? "secondary"}>
          {task.status}
        </Badge>
      </div>

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
            <p className="text-foreground whitespace-pre-wrap">{task.prompt}</p>
          </div>

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Repository</p>
            <a
              href={task.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-mono text-primary hover:underline"
            >
              {task.repoUrl}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {task.branch && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Branch</p>
              <p className="inline-flex items-center gap-1 text-sm font-mono text-foreground">
                <GitBranch className="h-3 w-3 text-muted-foreground" />
                {task.branch}
              </p>
            </div>
          )}

          {task.prUrl && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Pull Request</p>
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {task.prUrl}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          <Separator />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Created</p>
              <p className="text-sm">{formatTimestamp(task.createdAt)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Last Updated</p>
              <p className="text-sm">{formatTimestamp(task.updatedAt)}</p>
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
              {task.attachments.map((att, i) => (
                <li key={i} className="flex items-center gap-3 text-sm">
                  <Paperclip className="h-3 w-3 text-muted-foreground" />
                  <Badge variant="outline" className="font-mono text-xs">
                    {att.type}
                  </Badge>
                  <span>{att.name}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Verification Report */}
      {task.verificationReport && (
        <VerificationReportCard report={task.verificationReport as VerificationReportData} />
      )}

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
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <code className="text-xs text-muted-foreground">
                      {shortId(ws.id)}
                    </code>
                    <span className="text-sm">{ws.templateType}</span>
                  </div>
                  <Badge variant={statusVariant[ws.status] ?? "secondary"}>
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
                  <div key={log.id} className="flex items-start gap-3 py-1.5 text-sm">
                    <span className="shrink-0 text-xs text-muted-foreground font-mono tabular-nums min-w-[140px]">
                      {formatTimestamp(log.createdAt)}
                    </span>
                    <span className={log.level === "error" ? "text-destructive" : "text-foreground"}>
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
