"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { useAction } from "next-safe-action/hooks";
import { getTaskAction } from "@/lib/actions/tasks";

// ── Types ──────────────────────────────────────────────────────────

interface TaskLog {
  id: string;
  taskId: string;
  message: string;
  level: string;
  createdAt: string;
}

interface Workspace {
  id: string;
  taskId: string;
  coderWorkspaceId: string | null;
  templateType: string;
  status: string;
  createdAt: string;
}

interface Attachment {
  name: string;
  data: string;
  type: string;
}

interface Task {
  id: string;
  prompt: string;
  repoUrl: string;
  status: string;
  branch: string | null;
  prUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: Attachment[] | null;
  workspaces: Workspace[];
  logs: TaskLog[];
}

// ── Status badge styling (matches task list page) ──────────────────

const statusStyles: Record<string, string> = {
  queued: "bg-blue-900/50 text-blue-300 ring-1 ring-blue-500/30",
  running: "bg-yellow-900/50 text-yellow-300 ring-1 ring-yellow-500/30",
  verifying: "bg-purple-900/50 text-purple-300 ring-1 ring-purple-500/30",
  done: "bg-green-900/50 text-green-300 ring-1 ring-green-500/30",
  failed: "bg-red-900/50 text-red-300 ring-1 ring-red-500/30",
};

const workspaceStatusStyles: Record<string, string> = {
  pending: "bg-gray-800 text-gray-400",
  starting: "bg-blue-900/50 text-blue-300 ring-1 ring-blue-500/30",
  running: "bg-yellow-900/50 text-yellow-300 ring-1 ring-yellow-500/30",
  stopped: "bg-gray-800 text-gray-400 ring-1 ring-gray-600/30",
  deleted: "bg-gray-800 text-gray-500 ring-1 ring-gray-600/30",
  failed: "bg-red-900/50 text-red-300 ring-1 ring-red-500/30",
};

// ── Helpers ─────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatTimestamp(date: string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const ACTIVE_STATUSES = new Set(["queued", "running", "verifying"]);

// ── Component ───────────────────────────────────────────────────────

export function TaskDetail({ initialTask }: { initialTask: Task }) {
  const [task, setTask] = useState<Task>(initialTask);

  const { execute } = useAction(getTaskAction, {
    onSuccess: ({ data }) => {
      if (data) {
        setTask(data as Task);
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
      {/* Navigation breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link
          href="/tasks"
          className="hover:text-white transition-colors"
        >
          ← Back to Tasks
        </Link>
        <span className="text-gray-600">·</span>
        <span>
          Tasks &gt; Task {shortId(task.id)}
        </span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-white">
          Task {shortId(task.id)}
        </h1>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            statusStyles[task.status] ?? "bg-gray-800 text-gray-400"
          }`}
        >
          {task.status}
        </span>
      </div>

      {/* Error alert */}
      {task.errorMessage && (
        <div className="rounded-lg border border-red-500/30 bg-red-900/20 p-4">
          <p className="text-sm font-medium text-red-400">Error</p>
          <p className="mt-1 text-sm text-red-300">{task.errorMessage}</p>
        </div>
      )}

      {/* Task info card */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">
          Task Info
        </h2>

        {/* Prompt */}
        <div>
          <p className="text-xs text-gray-500 mb-1">Prompt</p>
          <p className="text-gray-200 whitespace-pre-wrap">{task.prompt}</p>
        </div>

        {/* Repo URL */}
        <div>
          <p className="text-xs text-gray-500 mb-1">Repository</p>
          <a
            href={task.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline text-sm font-mono"
          >
            {task.repoUrl}
          </a>
        </div>

        {/* Branch */}
        {task.branch && (
          <div>
            <p className="text-xs text-gray-500 mb-1">Branch</p>
            <p className="text-gray-300 font-mono text-sm">{task.branch}</p>
          </div>
        )}

        {/* PR URL */}
        {task.prUrl && (
          <div>
            <p className="text-xs text-gray-500 mb-1">Pull Request</p>
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline text-sm"
            >
              {task.prUrl}
            </a>
          </div>
        )}

        {/* Timestamps */}
        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-800">
          <div>
            <p className="text-xs text-gray-500 mb-1">Created</p>
            <p className="text-sm text-gray-400">{formatTimestamp(task.createdAt)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Last Updated</p>
            <p className="text-sm text-gray-400">{formatTimestamp(task.updatedAt)}</p>
          </div>
        </div>
      </div>

      {/* Attachments */}
      {task.attachments && task.attachments.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">
            Attachments
          </h2>
          <ul className="space-y-2">
            {task.attachments.map((att, i) => (
              <li
                key={i}
                className="flex items-center gap-3 text-sm text-gray-300"
              >
                <span className="inline-flex items-center rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400 font-mono">
                  {att.type}
                </span>
                <span>{att.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Workspaces */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">
          Workspaces
        </h2>
        {task.workspaces.length === 0 ? (
          <p className="text-sm text-gray-500">No workspaces created yet.</p>
        ) : (
          <div className="space-y-2">
            {task.workspaces.map((ws) => (
              <div
                key={ws.id}
                className="flex items-center justify-between rounded-lg border border-gray-800/50 bg-gray-800/30 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-gray-400">
                    {shortId(ws.id)}
                  </span>
                  <span className="text-sm text-gray-300">
                    {ws.templateType}
                  </span>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    workspaceStatusStyles[ws.status] ?? "bg-gray-800 text-gray-400"
                  }`}
                >
                  {ws.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Logs timeline */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">
          Logs
        </h2>
        {task.logs.length === 0 ? (
          <p className="text-sm text-gray-500">No log entries yet.</p>
        ) : (
          <div className="space-y-1">
            {task.logs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-3 py-1.5 text-sm"
              >
                <span className="shrink-0 text-xs text-gray-600 font-mono tabular-nums min-w-[140px]">
                  {formatTimestamp(log.createdAt)}
                </span>
                <span
                  className={
                    log.level === "error"
                      ? "text-red-400"
                      : "text-gray-300"
                  }
                >
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* S06 Streaming Placeholder */}
      <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/50 p-6">
        <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">
          Live Agent Activity
        </h2>
        <p className="mt-2 text-sm text-gray-500">
          Real-time agent streaming will be available in a future update.
        </p>
      </div>
    </div>
  );
}
