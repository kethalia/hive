"use server";

import { z } from "zod";
import { createTask, getTask, listTasks } from "@/lib/api/tasks";
import { authActionClient } from "@/lib/safe-action";
import { createTaskSchema } from "./tasks-contract";

// ── Schemas ───────────────────────────────────────────────────────

const getTaskSchema = z.object({
  id: z.string().uuid("Invalid task ID"),
});

// ── Actions ───────────────────────────────────────────────────────

export const createTaskAction = authActionClient
  .inputSchema(createTaskSchema)
  .action(async ({ parsedInput, ctx }) => {
    const task = await createTask({
      prompt: parsedInput.prompt,
      repoUrl: parsedInput.repoUrl,
      userId: ctx.user.id,
      attachments: parsedInput.attachments ?? null,
      councilSize: parsedInput.councilSize,
    });
    return task;
  });

export const getTaskAction = authActionClient
  .inputSchema(getTaskSchema)
  .action(async ({ parsedInput, ctx }) => {
    const task = await getTask(parsedInput.id, ctx.user.id);
    if (!task) {
      throw new Error("Task not found");
    }
    return JSON.parse(JSON.stringify(task));
  });

export const listTasksAction = authActionClient.action(async ({ ctx }) => {
  const tasks = await listTasks(ctx.user.id);
  return JSON.parse(JSON.stringify(tasks));
});
