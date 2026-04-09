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

/** Possible verification strategies. */
export type VerificationStrategy = "test-suite" | "web-app" | "static-site" | "none";

/** Possible verification outcomes. */
export type VerificationOutcome = "pass" | "fail" | "inconclusive";

/** Verification report data shape stored as JSON on completed tasks. */
export interface VerificationReportData {
  strategy: VerificationStrategy;
  outcome: VerificationOutcome;
  logs: string;
  durationMs: number;
  timestamp: string;
}

/**
 * Runtime type guard for VerificationReportData.
 * Validates the shape of Prisma's Json? column before rendering.
 */
export function isVerificationReport(v: unknown): v is VerificationReportData {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.strategy === "string" &&
    typeof obj.outcome === "string" &&
    typeof obj.durationMs === "number" &&
    typeof obj.timestamp === "string"
  );
}

export interface TaskWithRelations extends Task {
  workspaces: TaskWorkspace[];
  logs: TaskLog[];
  verificationReport: VerificationReportData | null;
}

/** Task statuses considered "in progress" — used for polling decisions. */
export const ACTIVE_STATUSES = new Set(["queued", "running", "verifying"]);
