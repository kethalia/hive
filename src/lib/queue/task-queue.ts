import { Queue, Worker, type Job } from "bullmq";
import { getRedisConnection } from "./connection";
import { getDb } from "@/lib/db";
import type { CoderClient } from "@/lib/coder/client";

// ── Types ─────────────────────────────────────────────────────────

/** Shape of job data on the task-dispatch queue. */
export interface TaskJobData {
  taskId: string;
  repoUrl: string;
  prompt: string;
  branchName: string;
  params: Record<string, string>;
}

// ── Queue ─────────────────────────────────────────────────────────

const QUEUE_NAME = "task-dispatch";

let queue: Queue<TaskJobData> | null = null;

/**
 * Returns the shared BullMQ queue for task dispatch.
 * Lazy singleton — created on first call.
 */
export function getTaskQueue(): Queue<TaskJobData> {
  if (!queue) {
    queue = new Queue<TaskJobData>(QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return queue;
}

// ── Worker ────────────────────────────────────────────────────────

/**
 * Creates a BullMQ worker that processes task-dispatch jobs.
 *
 * For each job:
 *   1. Updates task status to 'running'
 *   2. Calls CoderClient.createWorkspace with the worker template
 *   3. Records the workspace in Postgres
 *   4. Logs the outcome to taskLogs
 *
 * On error: sets task status to 'failed' and logs the error.
 *
 * Concurrency defaults to 5 (env WORKER_CONCURRENCY), enabling
 * parallel task execution per R008.
 */
export function createTaskWorker(coderClient: CoderClient): Worker<TaskJobData> {
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "5", 10);
  const templateId = process.env.CODER_WORKER_TEMPLATE_ID ?? "";

  const worker = new Worker<TaskJobData>(
    QUEUE_NAME,
    async (job: Job<TaskJobData>) => {
      const { taskId, repoUrl, prompt, branchName, params } = job.data;
      const db = getDb();

      console.log(`[queue] Processing job ${job.id} for task ${taskId}`);

      try {
        // 1. Update task status to 'running'
        await db.task.update({
          where: { id: taskId },
          data: { status: "running" },
        });

        console.log(`[task] Task ${taskId} status → running`);

        // 2. Create Coder workspace
        const workspaceName = `hive-worker-${taskId.slice(0, 8)}`;
        const workspace = await coderClient.createWorkspace(templateId, workspaceName, {
          task_id: taskId,
          task_prompt: prompt,
          repo_url: repoUrl,
          branch_name: branchName,
          ...params,
        });

        console.log(`[queue] Created workspace ${workspace.id} for task ${taskId}`);

        // 3. Record workspace in DB
        await db.workspace.create({
          data: {
            taskId,
            coderWorkspaceId: workspace.id,
            templateType: "worker",
            status: "starting",
          },
        });

        // 4. Log success
        await db.taskLog.create({
          data: {
            taskId,
            message: `Workspace ${workspace.name} (${workspace.id}) created`,
            level: "info",
          },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        console.error(`[queue] Job ${job.id} failed for task ${taskId}: ${errorMessage}`);

        // Update task to failed
        await db.task.update({
          where: { id: taskId },
          data: {
            status: "failed",
            errorMessage,
          },
        });

        console.log(`[task] Task ${taskId} status → failed`);

        // Log the error
        await db.taskLog.create({
          data: {
            taskId,
            message: `Worker error: ${errorMessage}`,
            level: "error",
          },
        });

        // Re-throw so BullMQ marks the job as failed
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency,
    }
  );

  console.log(`[queue] Task worker started (concurrency: ${concurrency})`);

  return worker;
}
