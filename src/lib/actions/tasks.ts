"use server";

import { z } from "zod";
import { actionClient } from "@/lib/safe-action";
import { createTask, getTask, listTasks } from "@/lib/api/tasks";

// ── Schemas ───────────────────────────────────────────────────────

const attachmentSchema = z.object({
  name: z.string(),
  data: z.string(),
  type: z.string(),
});

const createTaskSchema = z.object({
  prompt: z.string().min(1, "Prompt is required"),
  repoUrl: z.string().url("Must be a valid URL"),
  attachments: z.array(attachmentSchema).optional(),
});

const getTaskSchema = z.object({
  id: z.string().uuid("Invalid task ID"),
});

// ── Actions ───────────────────────────────────────────────────────

export const createTaskAction = actionClient
  .inputSchema(createTaskSchema)
  .action(async ({ parsedInput }) => {
    const task = await createTask({
      prompt: parsedInput.prompt,
      repoUrl: parsedInput.repoUrl,
      attachments: parsedInput.attachments ?? null,
    });
    return task;
  });

export const getTaskAction = actionClient
  .inputSchema(getTaskSchema)
  .action(async ({ parsedInput }) => {
    const task = await getTask(parsedInput.id);
    if (!task) {
      throw new Error("Task not found");
    }
    // Serialize dates for client consumption
    return JSON.parse(JSON.stringify(task));
  });

export const listTasksAction = actionClient
  .action(async () => {
    const tasks = await listTasks();
    return JSON.parse(JSON.stringify(tasks));
  });
