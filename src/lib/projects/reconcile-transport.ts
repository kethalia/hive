import { timingSafeEqual } from "node:crypto";

export const PROJECT_RECONCILE_PATH = "/api/internal/project-tasks/reconcile";
export const PROJECT_RECONCILE_DEADLINE = "X-Hive-Reconcile-Deadline";
export function projectReconcileDeadline(request: Request): number | null {
  const raw = request.headers.get(PROJECT_RECONCILE_DEADLINE);
  if (!raw || !/^\d{13}$/.test(raw)) return null;
  const deadline = Number(raw),
    now = Date.now();
  return deadline > now && deadline - now <= 45000 ? deadline : null;
}
export type ProjectReconcileEnvironment = {
  [key: string]: unknown;
  HIVE_PROJECT_TASKS_ENABLED?: string;
  HIVE_PROJECT_TASK_RECONCILE_SECRET?: string;
  PREVIEW_BEARER?: string;
  AUTH_SERVICE_SECRET?: string;
};
export function projectReconcilePath(request: Request) {
  return new URL(request.url).pathname === PROJECT_RECONCILE_PATH;
}
export function projectReconcileSecret(env: ProjectReconcileEnvironment): string | null {
  const secret = env.HIVE_PROJECT_TASK_RECONCILE_SECRET;
  return typeof secret === "string" &&
    /^[a-f0-9]{64}$/.test(secret) &&
    secret !== env.PREVIEW_BEARER &&
    secret !== env.AUTH_SERVICE_SECRET
    ? secret
    : null;
}
/** Only a deployment-owned private service credential authenticates this wakeup.
 * It carries no user scope; PostgreSQL selects one existing durable intent. */
export function authorizeProjectReconcile(request: Request, env: ProjectReconcileEnvironment) {
  if (env.HIVE_PROJECT_TASKS_ENABLED !== "true") return 404;
  const secret = projectReconcileSecret(env);
  if (!secret) return 503;
  const expected = Buffer.from(`Bearer ${secret}`),
    actual = Buffer.from(request.headers.get("Authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return 401;
  if (
    !projectReconcilePath(request) ||
    request.method !== "POST" ||
    request.url.includes("?") ||
    new URL(request.url).hash ||
    ["Origin", "Cookie", "Sec-Fetch-Site", "Upgrade", "Next-Action", "Content-Encoding"].some(
      (name) => request.headers.has(name),
    ) ||
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    return 400;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 512)) return 400;
  if (projectReconcileDeadline(request) === null) return 400;
  return null;
}
export function projectReconcileFailure(status: number) {
  return Response.json(
    { error: "project_reconciliation_unavailable" },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}
