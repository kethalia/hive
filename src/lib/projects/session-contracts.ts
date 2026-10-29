import { z } from "zod";
import { repositoryProjectSchema } from "./contracts";

export const projectOpenRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    requestId: z.string().uuid(),
  })
  .strict();
export const resolvedRepositorySchema = z
  .object({
    schemaVersion: z.literal(1),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    repository: repositoryProjectSchema,
    defaultRevision: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export const projectPhaseSchema = z.enum([
  "awaitingTask",
  "preparing",
  "awaitingRegistration",
  "awaitingFirstPrompt",
  "running",
  "blocked",
]);
export const enrolledProjectSchema = resolvedRepositorySchema
  .extend({
    projectId: z.string().uuid(),
    phase: projectPhaseSchema,
    currentTaskId: z.string().uuid().nullable(),
    nativeThreadId: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,160}$/)
      .nullable(),
    terminalSessionName: z
      .string()
      .regex(/^project-[a-f0-9]{24}$/)
      .nullable(),
  })
  .strict();
export const openedProjectSchema = enrolledProjectSchema
  .extend({
    workspaceId: z.string().uuid(),
  })
  .strict();
export type OpenedProject = z.infer<typeof openedProjectSchema>;
