// ── Task-related types used across dashboard pages ─────────────────

export interface TaskLog {
  id: string;
  taskId: string;
  message: string;
  level: string;
  createdAt: string;
}

export interface TaskWorkspace {
  id: string;
  taskId: string;
  coderWorkspaceId: string | null;
  templateType: string;
  status: string;
  createdAt: string;
}

export interface TaskAttachment {
  name: string;
  data: string;
  type: string;
}

export interface Task {
  id: string;
  prompt: string;
  repoUrl: string;
  status: string;
  branch: string | null;
  prUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: TaskAttachment[] | null;
}

export interface TaskWithRelations extends Task {
  workspaces: TaskWorkspace[];
  logs: TaskLog[];
}

/** Task statuses considered "in progress" — used for polling decisions. */
export const ACTIVE_STATUSES = new Set(["queued", "running", "verifying"]);
