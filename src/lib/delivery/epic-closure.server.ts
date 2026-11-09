import { createPrivateKey, sign } from "node:crypto";
import { type CodexGuardianRuntime, Prisma, type PrismaClient } from "@hive/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { guardianCheckoutSchema } from "@/lib/codex-session/guardian-contracts";
import { effectiveUnstartedSuccessor } from "@/lib/codex-session/guardian-unstarted-store.server";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { readCheckoutClosure, retainCheckoutClosure } from "./checkout-closure-ledger.server";
import { type EpicLeaseRelease, epicLeaseReleaseSchema } from "./epic-closure-contracts";
import { epicDigest } from "./epic-contracts";
import { epicDependencyRelease } from "./epic-dependency.server";
import { preserveEpicTask } from "./epic-preservation.server";
import { executionActorHistory } from "./execution-authority.server";
import { type EvidenceR2Bucket, R2GitHubArtifactStore } from "./github-artifacts.server";
import { DeliveryConflict } from "./state";

export async function closedTaskScope(
  db: Prisma.TransactionClient,
  runtime: CodexGuardianRuntime,
  projectId: string,
) {
  if (runtime.phase !== "tree_closed" || !runtime.closedBarrierId)
    throw new DeliveryConflict("epic_tree_not_closed");
  const barrier = await db.codexGuardianBarrier.findUnique({
    where: { ownerId_id: { ownerId: runtime.ownerId, id: runtime.closedBarrierId } },
  });
  if (!barrier || barrier.purpose !== "completion")
    throw new DeliveryConflict("epic_completion_closure_required");
  const admission = await db.codexGuardianAdmission.findFirst({
    where: { ownerId: runtime.ownerId, runtimeId: runtime.id, projectId, phase: "native" },
    include: { intent: true },
  });
  if (!admission?.checkoutBinding) throw new DeliveryConflict("epic_admission_unavailable");
  const checkout = guardianCheckoutSchema.parse(admission.checkoutBinding);
  const tasks = await db.deliveryTask.findMany({
    where: {
      ownerId: runtime.ownerId,
      projectId,
      managerBinding: {
        is: {
          preparationIntentId: admission.preparationIntentId,
          workspaceId: runtime.workspaceId,
        },
      },
    },
    include: { managerBinding: true },
    take: 2,
  });
  if (
    tasks.length !== 1 ||
    !tasks[0].managerBinding ||
    tasks[0].managerBinding.leaseId !== checkout.leaseId ||
    tasks[0].managerBinding.leaseGeneration !== checkout.leaseGeneration
  )
    throw new DeliveryConflict("epic_task_unbound");
  const task = tasks[0],
    binding = task.managerBinding;
  if (!binding) throw new DeliveryConflict("epic_task_unbound");
  if (
    !runtime.serverInstanceId ||
    !(await executionActorHistory(db, binding)).has(runtime.serverInstanceId)
  )
    throw new DeliveryConflict("epic_task_unbound");
  await epicDependencyRelease(db, runtime.ownerId, task.id);
  const trees = await db.$queryRaw<
    { digest: string }[]
  >`SELECT digest FROM codex_guardian_tree_receipts WHERE owner_id=${runtime.ownerId}::uuid AND runtime_id=${runtime.id}::uuid AND barrier_id=${runtime.closedBarrierId}::uuid`;
  const starts = await db.$queryRaw<
    { phase: string }[]
  >`SELECT phase FROM delivery_epic_start_intents WHERE owner_id=${runtime.ownerId}::uuid AND epic_id=${task.epicId}::uuid AND intent_id=${admission.preparationIntentId}::uuid`;
  if (
    trees.length !== 1 ||
    (task.epicId && (starts.length !== 1 || !["accepted", "finished"].includes(starts[0].phase)))
  )
    throw new DeliveryConflict("epic_tree_not_closed");
  const epicId = task.epicId;
  if (epicId) {
    const allocations = await db.$queryRaw<
      { workspace_id: string; build_id: string }[]
    >`SELECT workspace_id,build_id FROM delivery_epic_start_intents WHERE owner_id=${runtime.ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${admission.preparationIntentId}::uuid`;
    if (
      allocations.length !== 1 ||
      allocations[0].workspace_id !== runtime.workspaceId ||
      !(await effectiveUnstartedSuccessor(db, {
        ownerId: runtime.ownerId,
        taskId: admission.preparationIntentId,
        workspaceId: runtime.workspaceId,
        oldBuildId: allocations[0].build_id,
        newBuildId: binding.buildId,
      }))
    )
      throw new DeliveryConflict("epic_task_unbound");
  }
  return { admission, checkout, task, epicId, treeDigest: trees[0].digest };
}
export async function prepareEpicRelease(
  db: PrismaClient,
  runtime: CodexGuardianRuntime,
  projectId: string,
) {
  const before = await closedTaskScope(db, runtime, projectId);
  const { env } = await getCloudflareContext({ async: true });
  const bucket = (env as unknown as { HIVE_DELIVERY_EVIDENCE?: EvidenceR2Bucket })
    .HIVE_DELIVERY_EVIDENCE;
  if (!bucket) throw new DeliveryConflict("epic_preservation_unavailable");
  const preservation = await preserveEpicTask(
    db,
    new R2GitHubArtifactStore(bucket),
    runtime.ownerId,
    before.epicId,
    before.admission.preparationIntentId,
  );
  const current = await closedTaskScope(db, runtime, projectId);
  if (
    before.task.sourceSha !== current.task.sourceSha ||
    before.admission.generation !== current.admission.generation
  )
    throw new DeliveryConflict("epic_scope_changed");
  return {
    schemaVersion: 1,
    ownerId: (runtime.binding as unknown as RegistrationBinding).ownerId,
    hiveUserId: runtime.ownerId,
    workspaceId: runtime.workspaceId,
    buildId: runtime.buildId,
    projectId,
    epicId: current.task.epicId,
    taskId: current.admission.preparationIntentId,
    requestId: current.admission.intent.requestId,
    repositoryId: current.checkout.repositoryId,
    leaseId: current.checkout.leaseId,
    leaseGeneration: current.checkout.leaseGeneration,
    checkoutIncarnation: current.checkout.checkoutIncarnation,
    acceptedSourceSha: current.task.sourceSha,
    priorLifetimeId: runtime.lifetimeId,
    barrierId: runtime.closedBarrierId,
    treeReceiptDigest: current.treeDigest,
    preservationDigest: preservation.artifactDigest,
  };
}
export async function submitEpicRelease(
  db: PrismaClient,
  runtime: CodexGuardianRuntime,
  projectId: string,
  raw: EpicLeaseRelease,
  signingPem: string,
) {
  const release = epicLeaseReleaseSchema.parse(raw),
    current = await closedTaskScope(db, runtime, projectId);
  const c = current.checkout;
  if (
    release.repositoryId !== c.repositoryId ||
    release.taskId !== current.admission.preparationIntentId ||
    release.leaseId !== c.leaseId ||
    release.leaseGeneration !== c.leaseGeneration ||
    release.checkoutIncarnation !== c.checkoutIncarnation ||
    release.revision !== current.task.sourceSha ||
    String(release.checkoutIdentity.device) !== c.checkoutIdentity.device ||
    String(release.checkoutIdentity.inode) !== c.checkoutIdentity.inode
  )
    throw new DeliveryConflict("epic_release_scope_changed");
  const releaseDigest = epicDigest(release);
  const rows = current.epicId
    ? await db.$queryRaw<
        { artifact_digest: string }[]
      >`SELECT artifact_digest FROM delivery_epic_preservations WHERE owner_id=${runtime.ownerId}::uuid AND epic_id=${current.task.epicId}::uuid AND intent_id=${current.admission.preparationIntentId}::uuid AND source_sha=${current.task.sourceSha}`
    : await (async () => {
        const e = await readCheckoutClosure(
          db,
          runtime.ownerId,
          current.admission.preparationIntentId,
          "preserved",
        );
        const p = e?.payload as { sourceSha?: string; artifactDigest?: string } | undefined;
        return p?.sourceSha === current.task.sourceSha && p.artifactDigest
          ? [{ artifact_digest: p.artifactDigest }]
          : [];
      })();
  if (rows.length !== 1) throw new DeliveryConflict("epic_preservation_unavailable");
  if (current.epicId)
    await db.$executeRaw`INSERT INTO delivery_epic_lease_releases(owner_id,epic_id,intent_id,runtime_id,receipt_digest,receipt) VALUES (${runtime.ownerId}::uuid,${current.task.epicId}::uuid,${current.admission.preparationIntentId}::uuid,${runtime.id}::uuid,${releaseDigest},${JSON.stringify(release)}::jsonb) ON CONFLICT DO NOTHING`;
  if (!current.epicId)
    await db.$transaction((tx) =>
      retainCheckoutClosure(
        tx,
        {
          ownerId: runtime.ownerId,
          taskId: current.task.id,
          intentId: current.admission.preparationIntentId,
        },
        "lease_released",
        { receipt: release, receiptDigest: releaseDigest, runtimeId: runtime.id },
      ),
    );
  const saved = current.epicId
    ? await db.$queryRaw<
        { receipt_digest: string; runtime_id: string }[]
      >`SELECT receipt_digest,runtime_id FROM delivery_epic_lease_releases WHERE owner_id=${runtime.ownerId}::uuid AND epic_id=${current.task.epicId}::uuid AND intent_id=${current.admission.preparationIntentId}::uuid`
    : [{ receipt_digest: releaseDigest, runtime_id: runtime.id }];
  if (
    saved.length !== 1 ||
    saved[0].receipt_digest !== releaseDigest ||
    saved[0].runtime_id !== runtime.id
  )
    throw new DeliveryConflict("epic_release_scope_changed");
  const claims = {
    schemaVersion: 1,
    ownerId: (runtime.binding as unknown as RegistrationBinding).ownerId,
    hiveUserId: runtime.ownerId,
    workspaceId: runtime.workspaceId,
    buildId: runtime.buildId,
    projectId,
    repositoryId: c.repositoryId,
    taskId: current.admission.preparationIntentId,
    requestId: current.admission.intent.requestId,
    leaseId: c.leaseId,
    leaseGeneration: c.leaseGeneration,
    checkoutIncarnation: c.checkoutIncarnation,
    acceptedSourceSha: current.task.sourceSha,
    priorLifetimeId: runtime.lifetimeId,
    barrierId: runtime.closedBarrierId,
    treeReceiptDigest: current.treeDigest,
    preservationDigest: rows[0].artifact_digest,
    leaseReleaseDigest: releaseDigest,
    expiresAt: Date.now() + 45000,
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url"),
    key = createPrivateKey(signingPem);
  if (key.asymmetricKeyType !== "ed25519") throw new DeliveryConflict("epic_archive_unavailable");
  return {
    token: `${encoded}.${sign(null, Buffer.from(`hive-project-archive-v1\n${encoded}`), key).toString("base64url")}`,
  };
}
export async function acknowledgeEpicArchive(
  db: PrismaClient,
  runtime: CodexGuardianRuntime,
  projectId: string,
  archiveDigest: string,
  sourceArchiveDigest: string,
) {
  if (!/^[a-f0-9]{64}$/.test(archiveDigest) || !/^[a-f0-9]{64}$/.test(sourceArchiveDigest))
    throw new DeliveryConflict("epic_archive_invalid");
  const current = await closedTaskScope(db, runtime, projectId),
    ownerId = runtime.ownerId,
    epicId = current.epicId,
    intentId = current.admission.preparationIntentId;
  if (!epicId) {
    const release = await readCheckoutClosure(db, ownerId, intentId, "lease_released");
    const p = release?.payload as { receiptDigest?: string; runtimeId?: string } | undefined;
    if (p?.runtimeId !== runtime.id || !p.receiptDigest)
      throw new DeliveryConflict("epic_release_scope_changed");
    const combined = epicDigest({
      archiveDigest,
      sourceArchiveDigest,
      leaseReleaseDigest: p.receiptDigest,
      treeReceiptDigest: current.treeDigest,
    });
    await db.$transaction((tx) =>
      retainCheckoutClosure(tx, { ownerId, taskId: current.task.id, intentId }, "archived", {
        archiveDigest: combined,
        controllerArchiveDigest: archiveDigest,
        sourceArchiveDigest,
        runtimeId: runtime.id,
      }),
    );
    return { archived: true, archiveDigest: combined };
  }
  return db.$transaction(
    async (tx) => {
      const releases = await tx.$queryRaw<
        { receipt_digest: string }[]
      >`SELECT receipt_digest FROM delivery_epic_lease_releases WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${intentId}::uuid AND runtime_id=${runtime.id}::uuid`;
      if (releases.length !== 1) throw new DeliveryConflict("epic_release_scope_changed");
      const combined = epicDigest({
        archiveDigest,
        sourceArchiveDigest,
        leaseReleaseDigest: releases[0].receipt_digest,
        treeReceiptDigest: current.treeDigest,
      });
      const writers = await tx.$queryRaw<
        { phase: string; release_evidence_digest: string | null }[]
      >`
        SELECT phase,release_evidence_digest FROM delivery_epic_writer_reservations
        WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${intentId}::uuid
        AND task_id=${current.task.id}::uuid FOR UPDATE`;
      if (
        writers.length !== 1 ||
        !["held", "released"].includes(writers[0].phase) ||
        (writers[0].phase === "released" && writers[0].release_evidence_digest !== combined)
      )
        throw new DeliveryConflict("epic_writer_changed");
      await tx.$executeRaw`INSERT INTO delivery_epic_task_archives(owner_id,epic_id,intent_id,archive_digest) VALUES (${ownerId}::uuid,${epicId}::uuid,${intentId}::uuid,${combined}) ON CONFLICT DO NOTHING`;
      const saved = await tx.$queryRaw<
        { archive_digest: string }[]
      >`SELECT archive_digest FROM delivery_epic_task_archives WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${intentId}::uuid`;
      if (saved.length !== 1 || saved[0].archive_digest !== combined)
        throw new DeliveryConflict("epic_archive_changed");
      await tx.$executeRaw`UPDATE delivery_epic_writer_reservations SET phase='released',release_evidence_digest=${combined},released_at=clock_timestamp() WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${intentId}::uuid AND phase='held'`;
      await tx.$executeRaw`UPDATE delivery_epic_start_intents SET phase='finished' WHERE owner_id=${ownerId}::uuid AND epic_id=${epicId}::uuid AND intent_id=${intentId}::uuid AND phase='accepted'`;
      return { archived: true, archiveDigest: combined };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
