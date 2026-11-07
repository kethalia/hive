import { createHash } from "node:crypto";
import { decrypt } from "@hive/auth";
import type { Prisma } from "@hive/db";
import { z } from "zod";
import { acceptancePlanForIntent } from "./acceptance-policy.server";
import { epicIsolationSchema } from "./epic-claim.server";
import { epicDigest, epicPlanSchema, managerEpicProposalSchema } from "./epic-contracts";
import { epicDependencyRelease } from "./epic-dependency.server";
import { epicPreviewMergeReadiness } from "./epic-merge-observation.server";
import { expectedEpicIntent } from "./epic-plan.server";
import { stableDeliveryUuid } from "./manager-binding.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { DeliveryConflict } from "./state";

export async function managerEpicContext(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
  rawPolicy: unknown,
  catalog: readonly { tier: string; model: string; effort: string }[],
  encryptionKey: string,
  repositoryPolicies?: RepositoryPolicyStore,
) {
  const task = await tx.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId, id: taskId } },
    include: { managerBinding: true, epic: true },
  });
  if (!task?.epic || !task.managerBinding || !catalog.length)
    throw new DeliveryConflict("epic_planning_unavailable");
  await tx.$queryRaw`SELECT id FROM delivery_epics WHERE owner_id=${ownerId}::uuid AND id=${task.epic.id}::uuid FOR UPDATE`;
  const acceptance = await acceptancePlanForIntent(
    tx,
    ownerId,
    task.managerBinding.preparationIntentId,
  );
  if (!acceptance) throw new DeliveryConflict("epic_intent_unbound");
  const heads = await tx.$queryRaw<
    { version: number; plan_digest: string; plan: unknown; authored_by_task_id: string }[]
  >`SELECT h.version,h.plan_digest,p.plan,p.authored_by_task_id FROM delivery_epic_plan_heads h JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version WHERE h.owner_id=${ownerId}::uuid AND h.epic_id=${task.epic.id}::uuid FOR UPDATE OF h`;
  if (
    heads.length &&
    (heads[0].authored_by_task_id !== task.id || epicDigest(heads[0].plan) !== heads[0].plan_digest)
  )
    throw new DeliveryConflict("epic_author_unbound");
  const criteria = z.array(z.string()).min(1).max(20).parse(task.epic.criteria);
  if (
    epicDigest([...acceptance.plan.requirements.map((r) => r.id)].sort()) !==
    epicDigest([...criteria].sort())
  )
    throw new DeliveryConflict("epic_intent_unbound");
  const now = (
    await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
  )[0].now.getTime();
  const policy = epicIsolationSchema.parse(rawPolicy);
  const author = policy.workspaces.filter(
    (w) =>
      w.ownerId === ownerId &&
      w.workspaceId === task.managerBinding?.workspaceId &&
      w.buildId === task.managerBinding?.buildId &&
      w.validUntil > now,
  );
  if (author.length !== 1) throw new DeliveryConflict("epic_isolation_unverified");
  const currentTasks = [];
  if (heads.length) {
    const plan = epicPlanSchema.parse(heads[0].plan);
    for (const node of plan.tasks) {
      const rows = await tx.$queryRaw<
        { ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array; text_digest: string }[]
      >`
        SELECT ciphertext,iv,auth_tag,text_digest FROM delivery_epic_task_inputs
        WHERE owner_id=${ownerId}::uuid AND epic_id=${task.epic.id}::uuid
        AND plan_digest=${heads[0].plan_digest} AND intent_id=${node.intentId}::uuid`;
      if (rows.length !== 1) throw new DeliveryConflict("epic_plan_input_mismatch");
      const text = decrypt(
        {
          ciphertext: Buffer.from(rows[0].ciphertext),
          iv: Buffer.from(rows[0].iv),
          authTag: Buffer.from(rows[0].auth_tag),
        },
        encryptionKey,
      );
      if (
        createHash("sha256").update(text, "utf8").digest("hex") !== node.textDigest ||
        rows[0].text_digest !== node.textDigest
      )
        throw new DeliveryConflict("epic_plan_input_mismatch");
      const starts = await tx.$queryRaw<
        { phase: string }[]
      >`SELECT phase FROM delivery_epic_start_intents WHERE owner_id=${ownerId}::uuid AND epic_id=${task.epic.id}::uuid AND intent_id=${node.intentId}::uuid`;
      if (starts.length > 1) throw new DeliveryConflict("epic_task_unbound");
      let release = null;
      let integrationReadiness = null;
      if (["accepted", "finished"].includes(starts[0]?.phase)) {
        const children = await tx.deliveryTask.findMany({
          where: {
            ownerId,
            epicId: task.epic.id,
            managerBinding: { is: { preparationIntentId: node.intentId } },
          },
          select: { id: true },
          take: 2,
        });
        if (children.length !== 1) throw new DeliveryConflict("epic_task_unbound");
        if (starts[0].phase === "finished")
          release = await epicDependencyRelease(tx, ownerId, children[0].id);
        else if (repositoryPolicies)
          integrationReadiness = await epicPreviewMergeReadiness(tx, repositoryPolicies, {
            ownerId,
            epicId: task.epic.id,
            intentId: node.intentId,
          });
      }
      currentTasks.push({
        ...node,
        text,
        phase: starts[0]?.phase ?? "not_started",
        release,
        integrationReadiness,
      });
    }
  }
  return {
    ownerId,
    task,
    acceptance,
    criteria,
    head: heads[0] ?? null,
    currentTasks,
    workspaces: [
      ...new Set(
        policy.workspaces
          .filter(
            (w) =>
              w.ownerId === ownerId &&
              w.validUntil > now &&
              w.workspaceId !== author[0].workspaceId &&
              w.isolationDomain !== author[0].isolationDomain &&
              policy.workspaces.filter(
                (candidate) =>
                  candidate.ownerId === ownerId &&
                  candidate.workspaceId === w.workspaceId &&
                  candidate.validUntil > now,
              ).length === 1,
          )
          .map((w) => w.workspaceId),
      ),
    ],
    catalog,
  };
}
export function compileManagerEpicProposal(
  ownerId: string,
  context: Awaited<ReturnType<typeof managerEpicContext>>,
  raw: unknown,
) {
  const proposal = managerEpicProposalSchema.parse(raw),
    head = context.head;
  if (ownerId !== context.ownerId) throw new DeliveryConflict("epic_author_unbound");
  const fresh =
    proposal.expectedPlanVersion === (head?.version ?? 0) &&
    proposal.expectedPlanDigest === (head?.plan_digest ?? null);
  const replay =
    head &&
    head.version === proposal.expectedPlanVersion + 1 &&
    epicPlanSchema.parse(head.plan).previousPlanDigest === proposal.expectedPlanDigest;
  if (proposal.taskId !== context.task.id || (!fresh && !replay))
    throw new DeliveryConflict("epic_plan_version_conflict");
  const keys = new Set(proposal.tasks.map((task) => task.key));
  if (
    keys.size !== proposal.tasks.length ||
    proposal.tasks.some(
      (task) =>
        task.dependsOn.some((dep) => !keys.has(dep)) ||
        !context.workspaces.includes(task.workspaceId) ||
        !context.catalog.some((item) => item.tier === task.modelTier),
    )
  )
    throw new DeliveryConflict("epic_plan_input_mismatch");
  const identity = (value: string) => {
    const requestId = stableDeliveryUuid(
      `hive-epic-task-v1/${ownerId}/${context.task.epic?.id}/${value}`,
    );
    return { requestId, intentId: expectedEpicIntent(ownerId, context.task.projectId, requestId) };
  };
  const rendered = new Map(
    proposal.tasks.map((task) => {
      const selection = context.catalog.find((item) => item.tier === task.modelTier);
      if (!selection) throw new DeliveryConflict("epic_model_policy_changed");
      const requirements = task.criteria.map((id) => {
        const matches = context.acceptance.plan.requirements.filter((item) => item.id === id);
        if (matches.length !== 1) throw new DeliveryConflict("epic_acceptance_unbound");
        return matches[0];
      });
      const footer = `Owner acceptance requirements for this bounded task (independent review must cover each complete meaning and phase):\n${requirements.map((item) => `- ${JSON.stringify({ id: item.id, meaning: item.meaning, phase: item.phase })}`).join("\n")}\nDelegated execution tier ${selection.tier}: claim and spawn each native child with model ${selection.model} and reasoning effort ${selection.effort}. The controller verifies the effective settings.`;
      const text = task.text.endsWith(`\n\n${footer}`) ? task.text : `${task.text}\n\n${footer}`;
      return [task.key, text] as const;
    }),
  );
  const tasks = proposal.tasks.map((task) => ({
    ...identity(task.key),
    workspaceId: task.workspaceId,
    expectedRevision: task.expectedRevision,
    textDigest: createHash("sha256")
      .update(rendered.get(task.key) ?? "", "utf8")
      .digest("hex"),
    criteria: task.criteria,
    dependsOn: task.dependsOn.map((dep) => identity(dep).intentId),
    role: task.role,
    managerKey: task.key,
    modelTier: task.modelTier,
    model: context.catalog.find((item) => item.tier === task.modelTier)?.model,
    effort: context.catalog.find((item) => item.tier === task.modelTier)?.effort,
  }));
  const plan = epicPlanSchema.parse({
    schemaVersion: 1,
    epicId: context.task.epic?.id,
    projectId: context.task.projectId,
    ownerIntentDigest: context.acceptance.row.intentDigest,
    outcomeDigest: epicDigest(context.task.epic?.outcome),
    criteria: context.criteria,
    version: proposal.expectedPlanVersion + 1,
    previousPlanDigest: proposal.expectedPlanDigest,
    maxConcurrentTasks: proposal.maxConcurrentTasks,
    tasks,
  });
  return {
    plan,
    inputs: proposal.tasks.map((task) => ({
      intentId: identity(task.key).intentId,
      text: rendered.get(task.key) ?? "",
    })),
  };
}
