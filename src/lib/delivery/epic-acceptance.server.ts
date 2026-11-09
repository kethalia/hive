import { createHash } from "node:crypto";
import type { Prisma } from "@hive/db";
import { inheritedAcceptanceCriteriaSchema } from "./acceptance-contracts";
import { acceptancePlanForIntent } from "./acceptance-policy.server";
import { epicDigest, epicPlanSchema } from "./epic-contracts";
import { DeliveryConflict } from "./state";

/** Derive inherited criteria only from the owner's pinned plan and the exact
 * reserved node; task text or a manager cannot supply this authority. */
export async function inheritedEpicCriteria(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    projectId: string;
    intentId: string;
    workspaceId: string;
    text: string;
  },
) {
  const rows = await tx.$queryRaw<
    {
      plan: unknown;
      plan_digest: string;
      authored_by_task_id: string;
      epic_id: string;
      phase: string;
    }[]
  >`
    SELECT p.plan,p.plan_digest,p.authored_by_task_id,s.epic_id,s.phase FROM delivery_epic_start_intents s
    JOIN delivery_epic_plans p ON p.owner_id=s.owner_id AND p.epic_id=s.epic_id AND p.plan_digest=s.plan_digest
    WHERE s.owner_id=${input.ownerId}::uuid AND s.intent_id=${input.intentId}::uuid AND s.workspace_id=${input.workspaceId}::uuid`;
  if (!rows.length) return undefined;
  if (
    rows.length !== 1 ||
    !["reserved", "accepted"].includes(rows[0].phase) ||
    epicDigest(rows[0].plan) !== rows[0].plan_digest
  )
    throw new DeliveryConflict("epic_acceptance_unbound");
  const plan = epicPlanSchema.parse(rows[0].plan),
    node = plan.tasks.find((item) => item.intentId === input.intentId);
  if (
    !node ||
    plan.projectId !== input.projectId ||
    node.workspaceId !== input.workspaceId ||
    node.textDigest !== createHash("sha256").update(input.text, "utf8").digest("hex")
  )
    throw new DeliveryConflict("epic_acceptance_unbound");
  const author = await tx.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId: input.ownerId, id: rows[0].authored_by_task_id } },
    include: { managerBinding: true },
  });
  if (!author?.managerBinding || author.epicId !== rows[0].epic_id)
    throw new DeliveryConflict("epic_acceptance_unbound");
  const root = await acceptancePlanForIntent(
    tx,
    input.ownerId,
    author.managerBinding.preparationIntentId,
  );
  if (!root || root.row.intentDigest !== plan.ownerIntentDigest)
    throw new DeliveryConflict("epic_acceptance_unbound");
  const requirements = node.criteria.map((id) => {
    const found = root.plan.requirements.filter((item) => item.id === id);
    if (found.length !== 1) throw new DeliveryConflict("epic_acceptance_unbound");
    return { id, meaning: found[0].meaning, phase: found[0].phase };
  });
  return inheritedAcceptanceCriteriaSchema.parse({
    epicPlanDigest: rows[0].plan_digest,
    ownerPlanDigest: root.row.planDigest,
    requirements,
  });
}
