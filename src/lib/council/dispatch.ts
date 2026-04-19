/**
 * Council dispatch — fire-and-forget fan-out of reviewer jobs via FlowProducer.
 *
 * Extracted from task-queue.ts to keep the main worker focused on the core pipeline.
 * This function is informational (D015): failures are logged but never propagate.
 */

import { getDb } from "@/lib/db";
import { getCouncilFlowProducer } from "@/lib/queue/council-queues";
import { COUNCIL_AGGREGATOR_QUEUE, COUNCIL_REVIEWER_QUEUE } from "@/lib/constants";

interface CouncilDispatchParams {
  taskId: string;
  prUrl: string;
  repoUrl: string;
  branchName: string;
  userId: string;
}

/**
 * Dispatch a council review for a completed task.
 *
 * Reads councilSize from the DB, fans out N reviewer children + 1 aggregator
 * parent via FlowProducer, and returns immediately (fire-and-forget).
 *
 * @returns true if council was dispatched, false if skipped.
 * @throws on DB or Redis errors — caller must catch (task-queue.ts wraps in try/catch per D015).
 */
export async function dispatchCouncilReview(params: CouncilDispatchParams): Promise<boolean> {
  const { taskId, prUrl, repoUrl, branchName, userId } = params;

  const councilTemplateId = process.env.CODER_COUNCIL_TEMPLATE_ID;

  if (!prUrl || !councilTemplateId) {
    console.log(
      `[queue] Council review skipped for task ${taskId} ` +
        `(prUrl=${prUrl ?? "null"} templateId=${councilTemplateId ?? "not set"})`,
    );
    return false;
  }

  // Fetch councilSize from the task record
  const db = getDb();
  const taskRecord = await db.task.findUnique({
    where: { id: taskId },
    select: { councilSize: true },
  });

  const councilSize = taskRecord?.councilSize ?? 0;

  if (councilSize <= 0) {
    console.log(`[queue] Council review skipped for task ${taskId} (councilSize=${councilSize})`);
    return false;
  }

  console.log(`[queue] Starting council review for task ${taskId} (councilSize=${councilSize})`);

  const flowProducer = getCouncilFlowProducer();

  // Build reviewer children
  const children = Array.from({ length: councilSize }, (_, i) => ({
    name: `reviewer-${taskId}-${i}`,
    queueName: COUNCIL_REVIEWER_QUEUE,
    data: {
      taskId,
      reviewerIndex: i,
      prUrl,
      repoUrl,
      branchName,
      userId,
    },
    opts: { failParentOnFailure: false },
  }));

  // Add parent aggregator + children atomically
  const flow = await flowProducer.add({
    name: `aggregator-${taskId}`,
    queueName: COUNCIL_AGGREGATOR_QUEUE,
    data: {
      taskId,
      councilSize,
      prUrl,
    },
    children,
  });

  // Fire-and-forget: council is informational (D015), no need to
  // block the main worker slot. The aggregator job will persist
  // CouncilReport independently when it finishes.
  console.log(`[queue] Council review dispatched for task ${taskId} (flow=${flow.job.id})`);
  return true;
}
