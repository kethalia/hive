import type { Prisma, PrismaClient } from "@hive/db";
import { z } from "zod";
import {
  guardianCheckoutSchema,
  guardianDigest,
  guardianMetadataEvidenceSchema,
} from "@/lib/codex-session/guardian-contracts";
import { epicDigest, epicPlanSchema } from "./epic-contracts";
import { epicDependencyRelease } from "./epic-dependency.server";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { repositoryPolicyStore } from "./repository-policy.server";
import { DeliveryConflict } from "./state";

export const epicIsolationSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaces: z
      .array(
        z
          .object({
            ownerId: z.string().uuid(),
            workspaceId: z.string().uuid(),
            buildId: z.string().uuid(),
            isolationDomain: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
            validUntil: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
/** A deployment-owned enrollment attests dedicated provisioner storage. UUIDs
 * and device/inode values alone cannot prove different mount namespaces are
 * backed by independent disks; the trusted provisioning controller owns that
 * assertion. Guardian receipts independently bind the active checkout. */
export async function authorizeEpicClaim(
  tx: Prisma.TransactionClient,
  ownerId: string,
  task: { id: string; epicId: string | null; projectId: string; managerBindingId: string | null },
  rawPolicy: unknown,
  db: PrismaClient,
  requested: { model: string; effort: string },
) {
  if (!task.epicId) return;
  const policy = epicIsolationSchema.parse(rawPolicy);
  const heads = await tx.$queryRaw<
    { plan: unknown; plan_digest: string }[]
  >`SELECT p.plan,p.plan_digest FROM delivery_epic_plan_heads h JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version WHERE h.owner_id=${ownerId}::uuid AND h.epic_id=${task.epicId}::uuid FOR UPDATE OF h`;
  if (heads.length !== 1 || epicDigest(heads[0].plan) !== heads[0].plan_digest)
    throw new DeliveryConflict("epic_plan_unavailable");
  const plan = epicPlanSchema.parse(heads[0].plan);
  if (plan.projectId !== task.projectId || !task.managerBindingId)
    throw new DeliveryConflict("epic_task_unbound");
  const binding = await tx.deliveryManagerBinding.findUnique({
    where: { ownerId_id: { ownerId, id: task.managerBindingId } },
  });
  const node = plan.tasks.find((t) => t.intentId === binding?.preparationIntentId);
  if (
    !binding ||
    !node ||
    node.workspaceId !== binding.workspaceId ||
    node.expectedRevision !== binding.sourceSha
  )
    throw new DeliveryConflict("epic_task_unbound");
  if (!node.modelTier || node.model !== requested.model || node.effort !== requested.effort)
    throw new DeliveryConflict("epic_model_policy_changed");
  const start = await tx.$queryRaw<
    { phase: string; build_id: string; isolation_domain: string; plan_digest: string }[]
  >`SELECT phase,build_id,isolation_domain,plan_digest FROM delivery_epic_start_intents WHERE owner_id=${ownerId}::uuid AND epic_id=${task.epicId}::uuid AND intent_id=${node.intentId}::uuid AND workspace_id=${node.workspaceId}::uuid AND request_id=${node.requestId}::uuid`;
  if (start.length !== 1 || start[0].phase !== "accepted")
    throw new DeliveryConflict("epic_task_unbound");
  for (const dependency of node.dependsOn) {
    const rows = await tx.deliveryTask.findMany({
      where: {
        ownerId,
        epicId: task.epicId,
        managerBinding: { is: { preparationIntentId: dependency } },
      },
      select: { id: true, sourceSha: true },
      take: 2,
    });
    if (
      rows.length !== 1 ||
      !(await verifyReleaseEvidence(tx, repositoryPolicyStore(db), {
        ownerId,
        taskId: rows[0].id,
        sourceSha: rows[0].sourceSha,
      }))
    )
      throw new DeliveryConflict("epic_dependencies_pending");
    const release = await epicDependencyRelease(tx, ownerId, rows[0].id);
    const proofs = await tx.$queryRaw<{ proof: unknown; proof_digest: string }[]>`
      SELECT proof,proof_digest FROM delivery_epic_lineage_proofs WHERE owner_id=${ownerId}::uuid
      AND epic_id=${task.epicId}::uuid AND intent_id=${node.intentId}::uuid
      AND dependency_intent_id=${dependency}::uuid AND plan_digest=${start[0].plan_digest}`;
    const proof = z
      .object({
        dependency: z.string().uuid(),
        releaseId: z.string().uuid(),
        receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
        repositoryId: z.string(),
        base: z.string(),
        head: z.string(),
        status: z.enum(["ahead", "identical"]),
        mergeBase: z.string(),
      })
      .strict()
      .safeParse(proofs[0]?.proof);
    if (
      proofs.length !== 1 ||
      !proof.success ||
      epicDigest(proof.data) !== proofs[0].proof_digest ||
      proof.data.dependency !== dependency ||
      proof.data.releaseId !== release.releaseId ||
      proof.data.receiptDigest !== release.receiptDigest ||
      proof.data.repositoryId !== release.repositoryId ||
      proof.data.base !== release.mergeSha ||
      proof.data.mergeBase !== release.mergeSha ||
      proof.data.head !== node.expectedRevision
    )
      throw new DeliveryConflict("epic_dependencies_pending");
  }
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  const allocations = policy.workspaces.filter(
    (w) =>
      w.ownerId === ownerId &&
      w.workspaceId === binding.workspaceId &&
      w.buildId === binding.buildId &&
      w.validUntil > now.getTime(),
  );
  if (
    allocations.length !== 1 ||
    start[0].build_id !== binding.buildId ||
    start[0].isolation_domain !== allocations[0].isolationDomain
  )
    throw new DeliveryConflict("epic_isolation_unverified");
  const admission = await tx.codexGuardianAdmission.findMany({
    where: {
      ownerId,
      projectId: task.projectId,
      preparationIntentId: node.intentId,
      phase: "native",
      leaseId: binding.leaseId,
      leaseGeneration: binding.leaseGeneration,
      runtime: {
        is: {
          workspaceId: binding.workspaceId,
          buildId: binding.buildId,
          phase: "open",
          authorityUntil: { gt: now },
        },
      },
    },
    include: { runtime: true },
    take: 2,
  });
  if (admission.length !== 1) throw new DeliveryConflict("epic_isolation_unverified");
  const a = admission[0],
    checkout = guardianCheckoutSchema.parse(a.checkoutBinding),
    metadata = guardianMetadataEvidenceSchema.parse(a.metadataPins);
  if (
    a.checkoutBindingDigest !== guardianDigest(checkout) ||
    a.metadataPinsDigest !== guardianDigest(metadata) ||
    guardianDigest(metadata.pins.checkout) !== guardianDigest(checkout.checkoutIdentity) ||
    checkout.checkoutIncarnation !== a.checkoutIncarnation ||
    checkout.leaseId !== binding.leaseId ||
    checkout.projectId !== task.projectId ||
    checkout.preparationIntentId !== node.intentId ||
    checkout.repositoryId !== binding.repositoryId
  )
    throw new DeliveryConflict("epic_isolation_unverified");
  const identity = epicDigest(checkout.checkoutIdentity);
  const writers = await tx.$queryRaw<
    {
      intent_id: string;
      task_id: string;
      workspace_id: string;
      build_id: string;
      lease_id: string;
      checkout_incarnation: string;
      checkout_identity_digest: string;
      isolation_domain: string;
      phase: string;
    }[]
  >`SELECT intent_id,task_id,workspace_id,build_id,lease_id,checkout_incarnation,checkout_identity_digest,isolation_domain,phase FROM delivery_epic_writer_reservations WHERE owner_id=${ownerId}::uuid AND epic_id=${task.epicId}::uuid FOR UPDATE`;
  const own = writers.find((w) => w.intent_id === node.intentId);
  if (own) {
    if (
      own.phase !== "held" ||
      own.task_id !== task.id ||
      own.workspace_id !== binding.workspaceId ||
      own.build_id !== binding.buildId ||
      own.lease_id !== binding.leaseId ||
      own.checkout_incarnation !== checkout.checkoutIncarnation ||
      own.checkout_identity_digest !== identity ||
      own.isolation_domain !== allocations[0].isolationDomain
    )
      throw new DeliveryConflict("epic_writer_changed");
    return;
  }
  const held = writers.filter((w) => w.phase === "held");
  if (held.length >= plan.maxConcurrentTasks) throw new DeliveryConflict("epic_wip_limit");
  if (
    held.some(
      (w) =>
        w.workspace_id === binding.workspaceId ||
        w.lease_id === binding.leaseId ||
        w.checkout_incarnation === checkout.checkoutIncarnation ||
        w.checkout_identity_digest === identity ||
        w.isolation_domain === allocations[0].isolationDomain,
    )
  )
    throw new DeliveryConflict("epic_writer_overlap");
  await tx.$executeRaw`INSERT INTO delivery_epic_writer_reservations(owner_id,epic_id,intent_id,task_id,plan_digest,workspace_id,build_id,lease_id,checkout_incarnation,checkout_identity_digest,isolation_domain) VALUES (${ownerId}::uuid,${task.epicId}::uuid,${node.intentId}::uuid,${task.id}::uuid,${heads[0].plan_digest},${binding.workspaceId}::uuid,${binding.buildId}::uuid,${binding.leaseId}::uuid,${checkout.checkoutIncarnation}::uuid,${identity},${allocations[0].isolationDomain})`;
}
