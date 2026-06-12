import { z } from "zod";

const attachmentSchema = z.object({
  name: z.string(),
  data: z.string(),
  type: z.string(),
});

export const createTaskSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  repoUrl: z.string().url("Must be a valid URL"),
  attachments: z.array(attachmentSchema).optional(),
  councilSize: z.coerce.number().int().min(1).max(7).default(3),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
