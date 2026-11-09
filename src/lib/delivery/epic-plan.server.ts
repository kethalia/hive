import { createHash } from "node:crypto";
import { encrypt } from "@hive/auth";
import { Prisma } from "@hive/db";
import { acceptancePlanForIntent } from "./acceptance-policy.server";
import { epicDigest, epicPlanInputSchema, epicPlanSchema } from "./epic-contracts";
import { DeliveryConflict } from "./state";

const textDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Must match projectTaskId: retries cannot redirect an epic plan to a
 * different native preparation intent. */
export function expectedEpicIntent(ownerId: string, projectId: string, requestId: string) {
  const bytes = createHash("sha1")
    .update(Buffer.from("369ec1f59e0e41dfbf8c60f60eb9e13e", "hex"))
    .update(JSON.stringify([ownerId, projectId, requestId]))
    .digest();
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Called only inside an already signed, checkout-locked manager operation.
 * The owner intent and independent acceptance plan, not the manager, determine
 * the immutable outcome and criterion identities. */
export async function writeEpicPlan(
  tx: Prisma.TransactionClient,
  ownerId: string,
  authorTaskId: string,
  raw: unknown,
  encryptionKey: string,
) {
  const { plan, inputs } = epicPlanInputSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify({ plan, inputs }), "utf8") > 24576)
    throw new DeliveryConflict("epic_plan_input_limit");
  const ids = new Set(inputs.map((x) => x.intentId));
  if (
    ids.size !== inputs.length ||
    ids.size !== plan.tasks.length ||
    plan.tasks.some(
      (t) =>
        !ids.has(t.intentId) ||
        expectedEpicIntent(ownerId, plan.projectId, t.requestId) !== t.intentId ||
        textDigest(inputs.find((x) => x.intentId === t.intentId)?.text ?? "") !== t.textDigest,
    )
  )
    throw new DeliveryConflict("epic_plan_input_mismatch");
  const lock = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM delivery_epics WHERE owner_id=${ownerId}::uuid AND project_id=${plan.projectId}::uuid AND id=${plan.epicId}::uuid FOR UPDATE`;
  if (lock.length !== 1) throw new DeliveryConflict("epic_not_found");
  const epic = await tx.deliveryEpic.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: plan.epicId } },
  });
  const author = await tx.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId, id: authorTaskId } },
    include: { managerBinding: true },
  });
  if (
    !author ||
    author.epicId !== epic.id ||
    author.projectId !== epic.projectId ||
    !author.managerBinding ||
    plan.tasks.some((task) => task.intentId === author.managerBinding?.preparationIntentId)
  )
    throw new DeliveryConflict("epic_author_unbound");
  const acceptance = await acceptancePlanForIntent(
    tx,
    ownerId,
    author.managerBinding.preparationIntentId,
  );
  if (
    !acceptance ||
    acceptance.row.intentDigest !== plan.ownerIntentDigest ||
    epicDigest(epic.outcome) !== plan.outcomeDigest ||
    epicDigest(epic.criteria) !== epicDigest(plan.criteria) ||
    epicDigest([...acceptance.plan.requirements.map((r) => r.id)].sort()) !==
      epicDigest([...plan.criteria].sort())
  )
    throw new DeliveryConflict("epic_intent_unbound");
  const digest = epicDigest(plan),
    heads = await tx.$queryRaw<
      { version: number; plan_digest: string; plan: unknown; authored_by_task_id: string }[]
    >`SELECT h.version,h.plan_digest,p.plan,p.authored_by_task_id FROM delivery_epic_plan_heads h JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version WHERE h.owner_id=${ownerId}::uuid AND h.epic_id=${epic.id}::uuid FOR UPDATE OF h`;
  const head = heads[0];
  if (head && head.authored_by_task_id !== authorTaskId)
    throw new DeliveryConflict("epic_author_unbound");
  if (head && head.version === plan.version && head.plan_digest === digest)
    return { planDigest: digest, version: plan.version, replayed: true };
  if (
    (!head && (plan.version !== 1 || plan.previousPlanDigest !== null)) ||
    (head && (plan.version !== head.version + 1 || plan.previousPlanDigest !== head.plan_digest))
  )
    throw new DeliveryConflict("epic_plan_version_conflict");
  if (head) {
    const previous = epicPlanSchema.parse(head.plan);
    if (
      previous.ownerIntentDigest !== plan.ownerIntentDigest ||
      previous.outcomeDigest !== plan.outcomeDigest ||
      epicDigest(previous.criteria) !== epicDigest(plan.criteria)
    )
      throw new DeliveryConflict("epic_criteria_immutable");
    // Normalize joined fragments before the query reaches the Workerd Prisma client.
    const started = await tx.$queryRaw<{ intent_id: string }[]>(
      Prisma.sql`SELECT intent_id FROM delivery_epic_writer_reservations WHERE owner_id=${ownerId}::uuid AND epic_id=${epic.id}::uuid UNION SELECT intent_id FROM delivery_epic_start_intents WHERE owner_id=${ownerId}::uuid AND epic_id=${epic.id}::uuid UNION SELECT i.id AS intent_id FROM project_task_intents i WHERE i.owner_id=${ownerId}::uuid AND i.project_id=${epic.projectId}::uuid AND i.id IN (${Prisma.join(previous.tasks.map((t) => Prisma.sql`${t.intentId}::uuid`))})`,
    );
    for (const row of started) {
      const a = previous.tasks.find((t) => t.intentId === row.intent_id),
        b = plan.tasks.find((t) => t.intentId === row.intent_id);
      if (!a || !b || epicDigest(a) !== epicDigest(b))
        throw new DeliveryConflict("epic_started_task_immutable");
    }
  }
  await tx.$executeRaw`INSERT INTO delivery_epic_plans(owner_id,epic_id,version,plan,plan_digest,previous_plan_digest,authored_by_task_id) VALUES (${ownerId}::uuid,${epic.id}::uuid,${plan.version},${JSON.stringify(plan)}::jsonb,${digest},${plan.previousPlanDigest},${authorTaskId}::uuid)`;
  for (const item of inputs) {
    const encrypted = encrypt(item.text, encryptionKey);
    await tx.$executeRaw`INSERT INTO delivery_epic_task_inputs(owner_id,epic_id,plan_digest,intent_id,text_digest,ciphertext,iv,auth_tag) VALUES (${ownerId}::uuid,${epic.id}::uuid,${digest},${item.intentId}::uuid,${textDigest(item.text)},${encrypted.ciphertext},${encrypted.iv},${encrypted.authTag})`;
  }
  await tx.$executeRaw`INSERT INTO delivery_epic_plan_heads(owner_id,epic_id,version,plan_digest) VALUES (${ownerId}::uuid,${epic.id}::uuid,${plan.version},${digest}) ON CONFLICT(owner_id,epic_id) DO UPDATE SET version=EXCLUDED.version,plan_digest=EXCLUDED.plan_digest`;
  return { planDigest: digest, version: plan.version, replayed: false };
}
