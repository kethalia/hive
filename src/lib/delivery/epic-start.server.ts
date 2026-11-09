import type { Prisma, PrismaClient } from "@hive/db";
import { epicIsolationSchema } from "./epic-claim.server";
import { epicDigest, epicPlanSchema } from "./epic-contracts";
import {
  epicDependencyLineageSchema,
  epicIntegrationDependency,
  epicIntegrationReadyIntents,
  matchesEpicDependency,
} from "./epic-dependency.server";
import { repositoryPolicyStore } from "./repository-policy.server";
import { DeliveryConflict } from "./state";

/** Reserve before any checkout preparation. The caller must commit this in a
 * serializable transaction before dispatching the immutable project request.
 * An ambiguous dispatch retains its reservation until independently reconciled. */
export async function reserveEpicStart(
  tx: Prisma.TransactionClient,
  db: PrismaClient,
  ownerId: string,
  epicId: string,
  intentId: string,
  rawPolicy: unknown,
  lineage: readonly unknown[] = [],
) {
  const policy = epicIsolationSchema.parse(rawPolicy);
  const heads = await tx.$queryRaw<{ plan: unknown; plan_digest: string }[]>`
    SELECT p.plan,p.plan_digest FROM delivery_epic_plan_heads h
    JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
    WHERE h.owner_id=${ownerId}::uuid AND h.epic_id=${epicId}::uuid FOR UPDATE OF h`;
  if (heads.length !== 1 || epicDigest(heads[0].plan) !== heads[0].plan_digest)
    throw new DeliveryConflict("epic_plan_unavailable");
  const plan = epicPlanSchema.parse(heads[0].plan);
  if (plan.epicId !== epicId) throw new DeliveryConflict("epic_plan_unavailable");
  const node = plan.tasks.find((task) => task.intentId === intentId);
  if (!node) throw new DeliveryConflict("epic_task_unbound");
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  const allocations = policy.workspaces.filter(
    (entry) =>
      entry.ownerId === ownerId &&
      entry.workspaceId === node.workspaceId &&
      entry.validUntil > now.getTime(),
  );
  if (allocations.length !== 1) throw new DeliveryConflict("epic_isolation_unverified");
  const allocation = allocations[0];
  const starts = await tx.$queryRaw<
    {
      intent_id: string;
      workspace_id: string;
      build_id: string;
      isolation_domain: string;
      phase: string;
    }[]
  >`SELECT intent_id,workspace_id,build_id,isolation_domain,phase FROM delivery_epic_start_intents WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid FOR UPDATE`;
  const existing = starts.find((entry) => entry.intent_id === intentId);
  if (existing) {
    if (
      existing.workspace_id !== node.workspaceId ||
      existing.build_id !== allocation.buildId ||
      existing.isolation_domain !== allocation.isolationDomain ||
      existing.phase === "finished"
    )
      throw new DeliveryConflict("epic_start_changed");
    return { replayed: true, phase: existing.phase, planDigest: heads[0].plan_digest, node };
  }
  const policies = repositoryPolicyStore(db);
  const ready = await epicIntegrationReadyIntents(
    tx,
    policies,
    ownerId,
    epicId,
    starts.filter((entry) => entry.phase === "accepted").map((entry) => entry.intent_id),
  );
  if (
    starts.filter((entry) => entry.phase !== "finished" && !ready.has(entry.intent_id)).length >=
    plan.maxConcurrentTasks
  )
    throw new DeliveryConflict("epic_wip_limit");
  if (
    starts.some(
      (entry) =>
        entry.phase !== "finished" &&
        (entry.workspace_id === node.workspaceId ||
          entry.isolation_domain === allocation.isolationDomain),
    )
  )
    throw new DeliveryConflict("epic_writer_overlap");
  let captureValidUntil = allocation.validUntil;
  for (const dependency of node.dependsOn) {
    const anchor = await epicIntegrationDependency(tx, policies, {
      ownerId,
      epicId,
      intentId: dependency,
    });
    const proofs = lineage.flatMap((raw) => {
      const proof = epicDependencyLineageSchema.safeParse(raw);
      return proof.success &&
        matchesEpicDependency(proof.data, dependency, node.expectedRevision, anchor)
        ? [proof.data]
        : [];
    });
    if (proofs.length !== 1) throw new DeliveryConflict("epic_dependencies_pending");
    const proof = proofs[0];
    if ("milestone" in proof) {
      if (proof.observedAt > now.getTime() || proof.expiresAt <= now.getTime())
        throw new DeliveryConflict("epic_lineage_unavailable");
      captureValidUntil = Math.min(captureValidUntil, proof.expiresAt);
    }
    await tx.$executeRaw`INSERT INTO delivery_epic_lineage_proofs(owner_id,epic_id,intent_id,dependency_intent_id,plan_digest,repository_id,base_sha,head_sha,proof_digest,proof) VALUES (${ownerId}::uuid,${epicId}::uuid,${intentId}::uuid,${dependency}::uuid,${heads[0].plan_digest},${proof.repositoryId},${proof.base},${proof.head},${epicDigest(proof)},${JSON.stringify(proof)}::jsonb) ON CONFLICT DO NOTHING`;
    const recorded = await tx.$queryRaw<
      { proof_digest: string }[]
    >`SELECT proof_digest FROM delivery_epic_lineage_proofs WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${intentId}::uuid AND dependency_intent_id=${dependency}::uuid AND plan_digest=${heads[0].plan_digest}`;
    if (recorded.length !== 1 || recorded[0].proof_digest !== epicDigest(proof))
      throw new DeliveryConflict("epic_lineage_changed");
  }
  const inserted =
    await tx.$executeRaw`INSERT INTO delivery_epic_start_intents(owner_id,epic_id,intent_id,plan_digest,workspace_id,build_id,isolation_domain,request_id) VALUES (${ownerId}::uuid,${epicId}::uuid,${intentId}::uuid,${heads[0].plan_digest},${node.workspaceId}::uuid,${allocation.buildId}::uuid,${allocation.isolationDomain},${node.requestId}::uuid) ON CONFLICT DO NOTHING`;
  if (inserted !== 1) throw new DeliveryConflict("epic_writer_overlap");
  if (
    (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime() >=
    captureValidUntil
  )
    throw new DeliveryConflict("epic_lineage_unavailable");
  return { replayed: false, phase: "reserved", planDigest: heads[0].plan_digest, node };
}
