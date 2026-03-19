import { eq, desc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "@/lib/db";
import { tasks, taskLogs, workspaces } from "@/lib/db/schema";
import { getTaskQueue } from "@/lib/queue/task-queue";
import type { TaskJobData } from "@/lib/queue/task-queue";

// ── Helpers ───────────────────────────────────────────────────────

/** Slugify a string for branch naming: lowercase, replace non-alphanum with hyphens, trim. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Create a new task: insert into Postgres, enqueue a BullMQ job.
 * Returns the created task row.
 */
export async function createTask(input: {
  prompt: string;
  repoUrl: string;
}) {
  const db = getDb();
  const id = uuidv4();
  const branchName = `hive/${id.slice(0, 8)}/${slugify(input.prompt.slice(0, 30))}`;

  // 1. Persist task to Postgres
  const [task] = await db
    .insert(tasks)
    .values({
      id,
      prompt: input.prompt,
      repoUrl: input.repoUrl,
      status: "queued",
      branch: branchName,
    })
    .returning();

  console.log(`[task] Created task ${id} (status: queued)`);

  // 2. Enqueue BullMQ job
  const jobData: TaskJobData = {
    taskId: id,
    repoUrl: input.repoUrl,
    prompt: input.prompt,
    branchName,
    params: {},
  };

  const queue = getTaskQueue();
  await queue.add("dispatch", jobData, { jobId: id });

  console.log(`[task] Enqueued job for task ${id}`);

  // 3. Log creation
  await db.insert(taskLogs).values({
    taskId: id,
    message: `Task created and queued (branch: ${branchName})`,
    level: "info",
  });

  return task;
}

/**
 * Get a single task by ID, including related workspaces and recent logs.
 * Returns null if not found.
 */
export async function getTask(id: string) {
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
  });

  if (!task) return null;

  const relatedWorkspaces = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.taskId, id));

  const recentLogs = await db
    .select()
    .from(taskLogs)
    .where(eq(taskLogs.taskId, id))
    .orderBy(desc(taskLogs.createdAt))
    .limit(50);

  return {
    ...task,
    workspaces: relatedWorkspaces,
    logs: recentLogs,
  };
}

/**
 * List all tasks, ordered by createdAt desc, limited to 50.
 */
export async function listTasks() {
  const db = getDb();

  return db
    .select()
    .from(tasks)
    .orderBy(desc(tasks.createdAt))
    .limit(50);
}

/**
 * Update a task's status and optionally record an error message.
 * Also inserts a taskLog entry for the transition.
 */
export async function updateTaskStatus(
  id: string,
  status: string,
  errorMessage?: string
) {
  const db = getDb();

  await db
    .update(tasks)
    .set({
      status: status as "queued" | "running" | "verifying" | "done" | "failed",
      errorMessage: errorMessage ?? null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));

  await db.insert(taskLogs).values({
    taskId: id,
    message: errorMessage
      ? `Status → ${status}: ${errorMessage}`
      : `Status → ${status}`,
    level: status === "failed" ? "error" : "info",
  });

  console.log(`[task] Task ${id} status → ${status}`);
}
