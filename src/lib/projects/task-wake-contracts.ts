import { z } from "zod";

export const taskWakeIdentitySchema = z
  .object({
    ownerId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  })
  .strict();
export type TaskWakeIdentity = z.infer<typeof taskWakeIdentitySchema>;
export const TASK_WAKE_DURATION_MS = 30 * 60 * 1000;
export const TASK_WAKE_ATTEMPT_MS = 45_000;
export const TASK_WAKE_REQUEST_LIMIT = 100;
export const taskWakeReceiptSchema = taskWakeIdentitySchema
  .extend({
    schemaVersion: z.literal(1),
    createdAt: z.number().int().nonnegative(),
    deadline: z.number().int().positive(),
    requests: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    attempts: z.number().int().min(0).max(TASK_WAKE_REQUEST_LIMIT),
    phase: z.enum(["active", "running", "held"]),
    nextWake: z.number().int().nonnegative(),
    inFlightUntil: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (v) =>
      v.deadline === v.createdAt + TASK_WAKE_DURATION_MS &&
      (v.phase !== "active" || v.requests < TASK_WAKE_REQUEST_LIMIT),
  );
export type TaskWakeReceipt = z.infer<typeof taskWakeReceiptSchema>;
export type TaskWakeResult = { phase: "retry"; nextWake: number } | { phase: "running" | "held" };
export interface TaskWakeStub {
  reserve(identity: TaskWakeIdentity): Promise<TaskWakeReceipt>;
  inspect(identity: TaskWakeIdentity): Promise<TaskWakeReceipt>;
}
export type TaskWakeEnvironment = {
  HIVE_NATIVE_MODE?: string;
  HIVE_NATIVE_PREVIEW_ENABLED?: string;
  HIVE_PROJECT_TASK_WAKE_ENABLED?: string;
  HIVE_PROJECT_TASK_WAKE_TASK_JSON?: string;
  HIVE_PROJECT_TASK_WAKE?: { getByName(name: string): TaskWakeStub };
};
export function sameTaskWake(a: TaskWakeIdentity, b: TaskWakeIdentity) {
  return a.ownerId === b.ownerId && a.projectId === b.projectId && a.taskId === b.taskId;
}
export function taskWakeEnrollment(env: TaskWakeEnvironment) {
  if (env.HIVE_PROJECT_TASK_WAKE_ENABLED !== "true") return null;
  if (env.HIVE_NATIVE_MODE !== "preview" || env.HIVE_NATIVE_PREVIEW_ENABLED !== "true")
    throw new Error("task_wake_unavailable");
  return taskWakeIdentitySchema.parse(JSON.parse(env.HIVE_PROJECT_TASK_WAKE_TASK_JSON ?? "null"));
}
export function taskWakeName(identity: TaskWakeIdentity) {
  const parsed = taskWakeIdentitySchema.parse(identity);
  return `project-task/v1/${parsed.ownerId}/${parsed.taskId}`;
}
