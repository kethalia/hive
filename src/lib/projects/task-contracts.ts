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

export const preparationReasonMessages: Record<NonNullable<ProjectTaskStatus["reason"]>, string> = {
  github_auth_required: "Reconnect GitHub in your Coder account before retrying preparation.",
  repository_identity_changed:
    "Repository access or ownership changed. Reopen the project to verify access.",
  checkout_busy: "The project checkout is already in use. Resolve its active work before retrying.",
  checkout_unavailable:
    "The workspace could not prepare the checkout. Inspect the workspace before retrying.",
  revision_unavailable:
    "The requested revision is unavailable. Reopen the project to select current source.",
  model_unavailable:
    "The configured model is unavailable for this workspace account. Check its Codex sign-in and model access.",
  native_unavailable:
    "Codex could not be reached in the workspace. Check its connection and sign-in.",
  registration_unavailable:
    "The workspace could not establish its Hive connection. Check the workspace host configuration.",
  prompt_submission_uncertain:
    "The task may already have started. Inspect the existing conversation before taking further action.",
  task_identity_conflict:
    "This project already has another task or a different accepted request. Inspect its existing work.",
  preparation_timeout:
    "Preparation stopped making progress. Inspect the workspace before retrying.",
};
