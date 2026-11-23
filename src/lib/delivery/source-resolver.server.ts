import type { Prisma } from "@hive/db";
import type { SourceContext } from "./contracts";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
/** Physical checkout identity never advances. Only the immutable source ledger
 * can connect it to the current acceptance head. Call under the caller's locks. */
export async function resolveTaskSource(
  tx: Tx,
  ownerId: string,
  taskId: string,
  context?: SourceContext,
  requireContext = false,
) {
  const task = await tx.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId, id: taskId } },
    include: { managerBinding: true, currentSourceRevision: true },
  });
  if (!task) throw new DeliveryConflict("task_not_found");
  const revision = task.currentSourceRevision;
  if (!task.sourceRevisionId) {
    if (
      task.sourceVersion !== 0 ||
      context ||
      (task.managerBinding && task.sourceSha !== task.managerBinding.sourceSha)
    )
      throw new DeliveryConflict("source_revision_chain_invalid");
  } else {
    if (
      !revision ||
      revision.ownerId !== ownerId ||
      revision.taskId !== task.id ||
      revision.managerBindingId !== task.managerBindingId ||
      revision.version !== task.sourceVersion ||
      revision.headSha !== task.sourceSha ||
      revision.branch !== task.branch ||
      !task.managerBinding
    )
      throw new DeliveryConflict("source_revision_chain_invalid");
    if (
      (requireContext && !context) ||
      (context &&
        (context.revisionId !== revision.id ||
          context.version !== revision.version ||
          context.headSha !== revision.headSha))
    )
      throw new DeliveryConflict("source_context_stale");
  }
  return {
    task,
    physicalBase: task.managerBinding?.sourceSha ?? task.sourceSha,
    headSha: task.sourceSha,
    context: revision
      ? { revisionId: revision.id, version: revision.version, headSha: revision.headSha }
      : undefined,
  };
}

export async function resolveAttemptSource(
  tx: Tx,
  ownerId: string,
  taskId: string,
  attemptId: string,
  requireCurrent = true,
) {
  const source = await resolveTaskSource(tx, ownerId, taskId);
  const attempt = await tx.deliveryAttempt.findUnique({
    where: { ownerId_id: { ownerId, id: attemptId } },
    include: { step: true, outputRevision: true },
  });
  if (
    !attempt ||
    attempt.step.taskId !== taskId ||
    attempt.managerBindingId !== source.task.managerBindingId
  )
    throw new DeliveryConflict("source_attempt_scope_mismatch");
  const output = attempt.outputRevision;
  if (
    output &&
    (output.ownerId !== ownerId ||
      output.taskId !== taskId ||
      output.producingAttemptId !== attempt.id ||
      output.managerBindingId !== attempt.managerBindingId ||
      output.stepId !== attempt.stepId ||
      output.inputSha !== attempt.sourceSha)
  )
    throw new DeliveryConflict("source_output_scope_mismatch");
  const acceptedSha = output?.headSha ?? attempt.sourceSha;
  if (requireCurrent && acceptedSha !== source.headSha)
    throw new DeliveryConflict("source_revision_changed");
  // Earlier completed attempts can stay in the same held writer cohort; their
  // input must still belong to this chain rather than an arbitrary claimed SHA.
  if (
    attempt.sourceSha !== source.physicalBase &&
    !(await tx.deliverySourceRevision.findFirst({
      where: {
        ownerId,
        taskId,
        headSha: attempt.sourceSha,
        version: { lte: source.task.sourceVersion },
      },
    }))
  )
    throw new DeliveryConflict("source_input_not_in_chain");
  return { ...source, attempt, inputSha: attempt.sourceSha, acceptedSha, output };
}
