import { Queue, Worker, type Job } from "bullmq";
import { getRedisConnection } from "./connection";
import { getDb } from "@/lib/db";
import type { CoderClient } from "@/lib/coder/client";
import { runBlueprint } from "@/lib/blueprint/runner";
import { createHydrateStep } from "@/lib/blueprint/steps/hydrate";
import { createRulesStep } from "@/lib/blueprint/steps/rules";
import { createToolsStep } from "@/lib/blueprint/steps/tools";
import { createAgentStep } from "@/lib/blueprint/steps/agent";
import { createLintStep } from "@/lib/blueprint/steps/lint";
import { createCommitPushStep } from "@/lib/blueprint/steps/commit-push";
import { createCIStep } from "@/lib/blueprint/steps/ci";
import { createPRStep } from "@/lib/blueprint/steps/pr";
import { cleanupWorkspace } from "@/lib/workspace/cleanup";
import type { BlueprintContext } from "@/lib/blueprint/types";

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

/** 90 minutes — accounts for CI polling + agent retry rounds. */
const JOB_TIMEOUT_MS = 90 * 60 * 1_000;

/**
 * Creates a BullMQ worker that processes task-dispatch jobs.
 *
 * For each job:
 *   1. Updates task status to 'running'
 *   2. Calls CoderClient.createWorkspace with the worker template
 *   3. Records the workspace in Postgres
 *   4. Waits for workspace build to reach 'running'
 *   5. Resolves the SSH-addressable agent name
 *   6. Runs the full blueprint: hydrate → rules → tools → agent
 *   7. Updates task status to 'done' or 'failed' based on result
 *
 * On error: sets task status to 'failed' and logs the error.
 *
 * Concurrency defaults to 5 (env WORKER_CONCURRENCY), enabling
 * parallel task execution per R008.
 */
export function createTaskWorker(coderClient: CoderClient): Worker<TaskJobData> {
  const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? "5", 10);
  const templateId = process.env.CODER_WORKER_TEMPLATE_ID ?? "";
  const piProvider = process.env.PI_PROVIDER ?? "anthropic";
  const piModel = process.env.PI_MODEL ?? "claude-sonnet-4-20250514";

  const worker = new Worker<TaskJobData>(
    QUEUE_NAME,
    async (job: Job<TaskJobData>) => {
      const { taskId, repoUrl, prompt, branchName, params } = job.data;
      const db = getDb();
      const graceMs = parseInt(process.env.CLEANUP_GRACE_MS ?? "60000", 10);

      // Track workspace ID for cleanup in finally block
      let coderWorkspaceId: string | undefined;

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

        coderWorkspaceId = workspace.id;

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

        // 4. Log workspace creation
        await db.taskLog.create({
          data: {
            taskId,
            message: `Workspace ${workspace.name} (${workspace.id}) created`,
            level: "info",
          },
        });

        // 5. Wait for workspace build to reach 'running' (5-min timeout)
        console.log(`[queue] Waiting for workspace build to complete (task=${taskId})`);
        await coderClient.waitForBuild(workspace.id, "running", {
          timeoutMs: 300_000,
        });

        // 6. Update workspace status to 'running'
        await db.workspace.update({
          where: { coderWorkspaceId: workspace.id },
          data: { status: "running" },
        });

        await db.taskLog.create({
          data: {
            taskId,
            message: "Workspace build completed — status: running",
            level: "info",
          },
        });

        console.log(`[queue] Workspace build complete for task ${taskId}`);

        // 7. Resolve SSH agent name
        const agentName = await coderClient.getWorkspaceAgentName(workspace.id);
        console.log(`[queue] Resolved agent name: ${agentName} (task=${taskId})`);

        // 8. Build blueprint context
        const ctx: BlueprintContext = {
          taskId,
          workspaceName: agentName,
          repoUrl,
          prompt,
          branchName,
          assembledContext: "",
          scopedRules: "",
          toolFlags: [],
          piProvider,
          piModel,
        };

        // 9. Run the full blueprint: hydrate → rules → tools → agent → lint → commit-push → ci → pr
        const steps = [
          createHydrateStep(),
          createRulesStep(),
          createToolsStep(),
          createAgentStep(),
          createLintStep(),
          createCommitPushStep(),
          createCIStep({ createAgentStep, createLintStep, createCommitPushStep }),
          createPRStep(),
        ];

        console.log(`[queue] Starting blueprint for task ${taskId}`);

        const result = await runBlueprint(steps, ctx);

        // 10. Log each step outcome
        for (const step of result.steps) {
          await db.taskLog.create({
            data: {
              taskId,
              message: `Blueprint step "${step.name}": ${step.status} — ${step.message}`,
              level: step.status === "failure" ? "error" : "info",
            },
          });
        }

        // 11. Update task status based on result
        if (result.success) {
          await db.task.update({
            where: { id: taskId },
            data: {
              status: "done",
              prUrl: ctx.prUrl ?? null,
              branch: ctx.branchName,
            },
          });

          console.log(`[task] Task ${taskId} status → done (${result.totalDurationMs}ms)`);

          await db.taskLog.create({
            data: {
              taskId,
              message: `Blueprint completed successfully in ${result.totalDurationMs}ms`,
              level: "info",
            },
          });
        } else {
          // Find the failed step for the error message
          const failedStep = result.steps.find((s) => s.status === "failure");
          const errorMessage = failedStep
            ? `Blueprint failed at step "${failedStep.name}": ${failedStep.message}`
            : "Blueprint failed (unknown step)";

          await db.task.update({
            where: { id: taskId },
            data: {
              status: "failed",
              errorMessage,
            },
          });

          console.log(`[task] Task ${taskId} status → failed: ${errorMessage}`);

          await db.taskLog.create({
            data: {
              taskId,
              message: errorMessage,
              level: "error",
            },
          });
        }
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
      } finally {
        // Cleanup workspace on both success and failure paths
        if (coderWorkspaceId) {
          cleanupWorkspace(coderClient, coderWorkspaceId, graceMs, db as any);
        }
      }
    },
    {
      connection: getRedisConnection(),
      concurrency,
      lockDuration: JOB_TIMEOUT_MS,
    }
  );

  console.log(`[queue] Task worker started (concurrency: ${concurrency})`);

  return worker;
}
