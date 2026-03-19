import { v4 as uuidv4 } from "uuid";
import { getDb } from "@/lib/db";
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
  attachments?: Array<{ name: string; data: string; type: string }> | null;
}) {
  const db = getDb();
  const id = uuidv4();
  const branchName = `hive/${id.slice(0, 8)}/${slugify(input.prompt.slice(0, 30))}`;

  // 1. Persist task to Postgres
  const task = await db.task.create({
    data: {
      id,
      prompt: input.prompt,
      repoUrl: input.repoUrl,
      status: "queued",
      branch: branchName,
      attachments: input.attachments ?? undefined,
    },
  });

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
  await db.taskLog.create({
    data: {
      taskId: id,
      message: `Task created and queued (branch: ${branchName})`,
      level: "info",
    },
  });

  return task;
}

/**
 * Get a single task by ID, including related workspaces and recent logs.
 * Returns null if not found.
 */
export async function getTask(id: string) {
  const db = getDb();

  const task = await db.task.findUnique({
    where: { id },
    include: {
      workspaces: true,
      logs: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });

  return task ?? null;
}

/**
 * List all tasks, ordered by createdAt desc, limited to 50.
 */
export async function listTasks() {
  const db = getDb();

  return db.task.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
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

  await db.task.update({
    where: { id },
    data: {
      status: status as "queued" | "running" | "verifying" | "done" | "failed",
      errorMessage: errorMessage ?? null,
    },
  });

  await db.taskLog.create({
    data: {
      taskId: id,
      message: errorMessage
        ? `Status → ${status}: ${errorMessage}`
        : `Status → ${status}`,
      level: status === "failed" ? "error" : "info",
    },
  });

  console.log(`[task] Task ${id} status → ${status}`);
}
