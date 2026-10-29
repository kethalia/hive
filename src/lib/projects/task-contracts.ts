import { z } from "zod";
import { projectPhaseSchema } from "./session-contracts";
export const projectTaskStartSchema = z
  .object({
    workspaceId: z.string().uuid(),
    requestId: z.string().uuid(),
    expectedRevision: z.string().regex(/^[a-f0-9]{40}$/),
    text: z
      .string()
      .trim()
      .min(1)
      .refine(
        (v) =>
          ![...v].some((c) => {
            const n = c.charCodeAt(0);
            return (n < 32 && ![9, 10, 13].includes(n)) || n === 127;
          }),
      )
      .refine((v) => new TextEncoder().encode(v).length <= 32768),
  })
  .strict();
export const projectTaskReadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    taskId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();
export const projectTaskStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    phase: projectPhaseSchema,
    nativeThreadId: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,160}$/)
      .nullable(),
    terminalSessionName: z
      .string()
      .regex(/^project-[a-f0-9]{24}$/)
      .nullable(),
    reason: z
      .enum([
        "github_auth_required",
        "repository_identity_changed",
        "checkout_busy",
        "checkout_unavailable",
        "revision_unavailable",
        "model_unavailable",
        "native_unavailable",
        "registration_unavailable",
        "prompt_submission_uncertain",
        "task_identity_conflict",
        "preparation_timeout",
      ])
      .nullable(),
  })
  .strict();
export type ProjectTaskStatus = z.infer<typeof projectTaskStatusSchema>;
