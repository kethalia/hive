import { createPrivateKey, sign } from "node:crypto";
import type { CodexGuardianRuntime, Prisma, PrismaClient } from "@hive/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { lockAccountMaintenanceWorkspace } from "@/lib/codex-session/account-maintenance-store.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import {
  productionAcceptanceConfig,
  productionAcceptanceStepMaterial,
} from "./acceptance-production.server";
import {
  type CheckoutCleanupRequest,
  type CheckoutVolumeEvidence,
  checkoutCleanupClaimsSchema,
  checkoutCleanupReceiptSchema,
  checkoutCleanupRequestSchema,
  checkoutVolumeEvidenceSchema,
} from "./checkout-cleanup-contracts";
import {
  latestCheckoutClosure,
  readCheckoutClosure,
  retainCheckoutClosure,
} from "./checkout-closure-ledger.server";
import { closedTaskScope } from "./epic-closure.server";
import { type EvidenceR2Bucket, R2GitHubArtifactStore } from "./github-artifacts.server";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { repositoryPolicyStore } from "./repository-policy.server";
import { DeliveryConflict } from "./state";

const check: (value: unknown) => asserts value = (value) => {
  if (!value) throw new DeliveryConflict("checkout_cleanup_unavailable");
};
const ledgerId = (r: CheckoutCleanupRequest) =>
  `${r.binding.taskId}/${r.binding.checkoutIncarnation}/${r.binding.cleanupRequestId}`;
export function signCheckoutCleanup(claims: unknown, privateKeyPem: string) {
  const parsed = checkoutCleanupClaimsSchema.parse(claims),
    body = Buffer.from(JSON.stringify(parsed)).toString("base64url"),
    key = createPrivateKey(privateKeyPem);
  check(key.asymmetricKeyType === "ed25519");
  return `${body}.${sign(null, Buffer.from(`hive-project-cleanup-v1\n${body}`), key).toString("base64url")}`;
}
async function facts(
  tx: Prisma.TransactionClient,
  db: PrismaClient,
  runtime: CodexGuardianRuntime,
  current: CodexGuardianRuntime,
  input: CheckoutCleanupRequest,
) {
  check(runtime.ownerId === current.ownerId && runtime.workspaceId === current.workspaceId);
  if (runtime.id !== current.id) {
    check(current.phase === "open" && !current.nativeLaunchId && !current.serverInstanceId);
    check(
      (await tx.codexGuardianAdmission.count({
        where: { ownerId: current.ownerId, runtimeId: current.id },
      })) === 0,
    );
  }
  const scope = await closedTaskScope(tx, runtime, input.projectId),
    c = scope.checkout,
    b = input.binding;
  check(
    b.repositoryId === c.repositoryId &&
      b.taskId === scope.admission.preparationIntentId &&
      b.revision === scope.task.sourceSha &&
      b.checkoutIncarnation === c.checkoutIncarnation &&
      b.leaseGeneration === c.leaseGeneration &&
      guardianDigest(b.checkoutIdentity) === guardianDigest(c.checkoutIdentity),
  );
  const policies = repositoryPolicyStore(db);
  check(
    await verifyReleaseEvidence(tx, policies, {
      ownerId: runtime.ownerId,
      taskId: scope.task.id,
      sourceSha: scope.task.sourceSha,
    }),
  );
  const enrolled = await policies.resolveTask(tx, runtime.ownerId, scope.task.id);
  check(enrolled);
  const steps = await tx.deliveryStep.findMany({
    where: {
      ownerId: runtime.ownerId,
      taskId: scope.task.id,
      acceptancePhase: "activation_production",
      state: "succeeded",
    },
    orderBy: { id: "asc" },
    take: 65,
  });
  check(steps.length > 0 && steps.length <= 64 && scope.task.sourceRevisionId);
  const completions: string[] = [];
  let production: Awaited<ReturnType<typeof productionAcceptanceStepMaterial>> | undefined;
  for (const step of steps) {
    const anchor = await productionAcceptanceStepMaterial(tx, {
      ownerId: runtime.ownerId,
      taskId: scope.task.id,
      stepId: step.id,
      sourceRevisionId: scope.task.sourceRevisionId,
      sourceSha: scope.task.sourceSha,
    });
    check(!production || production.releaseId === anchor.releaseId);
    production = anchor;
    const events = await tx.deliveryEvent.findMany({
      where: {
        ownerId: runtime.ownerId,
        taskId: scope.task.id,
        stepId: step.id,
        type: "acceptance_success_completed",
      },
      take: 129,
    });
    const matching = events.filter(
      (e) =>
        (e.payload as { receipt?: { version?: number } } | null)?.receipt?.version === step.version,
    );
    check(matching.length === 1);
    completions.push(matching[0].id);
  }
  check(production);
  let preservation: { artifactKey: string; artifactDigest: string; sessionDigest: string },
    leaseReleaseDigest: string,
    archiveDigest: string;
  if (scope.epicId) {
    const preserved = await tx.$queryRaw<
      { artifact_key: string; artifact_digest: string; session_digest: string }[]
    >`SELECT artifact_key,artifact_digest,session_digest FROM delivery_epic_preservations WHERE owner_id=${runtime.ownerId}::uuid AND epic_id=${scope.epicId}::uuid AND intent_id=${scope.admission.preparationIntentId}::uuid AND source_sha=${scope.task.sourceSha}`;
    const released = await tx.$queryRaw<
      { receipt_digest: string; receipt: unknown; runtime_id: string }[]
    >`SELECT receipt_digest,receipt,runtime_id FROM delivery_epic_lease_releases WHERE owner_id=${runtime.ownerId}::uuid AND epic_id=${scope.epicId}::uuid AND intent_id=${scope.admission.preparationIntentId}::uuid`;
    const archived = await tx.$queryRaw<
      { archive_digest: string }[]
    >`SELECT archive_digest FROM delivery_epic_task_archives WHERE owner_id=${runtime.ownerId}::uuid AND epic_id=${scope.epicId}::uuid AND intent_id=${scope.admission.preparationIntentId}::uuid`;
    check(
      preserved.length === 1 &&
        released.length === 1 &&
        archived.length === 1 &&
        released[0].runtime_id === runtime.id &&
        guardianDigest(released[0].receipt) === released[0].receipt_digest,
    );
    preservation = {
      artifactKey: preserved[0].artifact_key,
      artifactDigest: preserved[0].artifact_digest,
      sessionDigest: preserved[0].session_digest,
    };
    leaseReleaseDigest = released[0].receipt_digest;
    archiveDigest = archived[0].archive_digest;
  } else {
    const p = await readCheckoutClosure(tx, runtime.ownerId, b.taskId, "preserved"),
      l = await readCheckoutClosure(tx, runtime.ownerId, b.taskId, "lease_released"),
      a = await readCheckoutClosure(tx, runtime.ownerId, b.taskId, "archived");
    check(
      p &&
        l &&
        a &&
        p.taskId === scope.task.id &&
        l.taskId === scope.task.id &&
        a.taskId === scope.task.id,
    );
    const saved = p.payload as {
        sourceSha: string;
        artifactKey: string;
        artifactDigest: string;
        sessionDigest: string;
      },
      released = l.payload as { runtimeId: string; receipt: unknown; receiptDigest: string },
      archived = a.payload as { archiveDigest: string; runtimeId: string };
    check(
      saved.sourceSha === scope.task.sourceSha &&
        released.runtimeId === runtime.id &&
        archived.runtimeId === runtime.id &&
        guardianDigest(released.receipt) === released.receiptDigest,
    );
    preservation = saved;
    leaseReleaseDigest = released.receiptDigest;
    archiveDigest = archived.archiveDigest;
  }
  check(
    archiveDigest ===
      guardianDigest({
        archiveDigest: input.controllerArchiveDigest,
        sourceArchiveDigest: input.sourceArchiveDigest,
        leaseReleaseDigest,
        treeReceiptDigest: scope.treeDigest,
      }),
  );
  return {
    taskId: scope.task.id,
    sourceRevisionId: scope.task.sourceRevisionId,
    policyVersion: enrolled.binding.policyVersionId,
    production,
    completionEventIds: completions,
    preservation,
    leaseReleaseDigest,
    treeReceiptDigest: scope.treeDigest,
  };
}
export async function prepareCheckoutCleanup(
  db: PrismaClient,
  current: CodexGuardianRuntime,
  raw: unknown,
  rawVolume: CheckoutVolumeEvidence,
  signingPem: string,
  artifacts?: Pick<R2GitHubArtifactStore, "readAndVerify">,
  authorizationUntil = Date.now() + 45000,
) {
  check(Number.isSafeInteger(authorizationUntil) && authorizationUntil > Date.now());
  const policyUntil = productionAcceptanceConfig().policy.expiresAt;
  const input = checkoutCleanupRequestSchema.parse(raw),
    volume = checkoutVolumeEvidenceSchema.parse(rawVolume);
  check(
    volume.buildId === current.buildId &&
      volume.lifetimeId === current.lifetimeId &&
      volume.volumeDigest === guardianDigest(volume.volume) &&
      volume.observedAt <= Date.now() &&
      Date.now() - volume.observedAt <= 30000,
  );
  const runtime = await db.codexGuardianRuntime.findFirstOrThrow({
    where: { ownerId: current.ownerId, id: input.closedRuntimeId },
  });
  const snapshot = () =>
    db.$transaction((tx) => facts(tx, db, runtime, current, input), {
      isolationLevel: "Serializable",
    });
  const before = await snapshot(),
    saved = await latestCheckoutClosure(db, current.ownerId, ledgerId(input), "cleanup_authorized");
  const exactRefreshReplay = (claims: ReturnType<typeof checkoutCleanupClaimsSchema.parse>) =>
    input.retry &&
    claims.previousAuthorizationDigest === input.retry.previousAuthorizationDigest &&
    claims.refreshInspectionDigest === guardianDigest(input.retry);
  if (saved) {
    const claims = checkoutCleanupClaimsSchema.parse(saved.payload);
    check(
      saved.taskId === before.taskId &&
        guardianDigest(claims.binding) === guardianDigest(input.binding) &&
        claims.closedRuntimeId === runtime.id &&
        claims.buildId === current.buildId &&
        claims.configSha256 === current.configSha256 &&
        claims.lifetimeId === current.lifetimeId &&
        claims.policyVersion === before.policyVersion,
    );
    if (!input.retry || exactRefreshReplay(claims))
      return { token: signCheckoutCleanup(claims, signingPem) };
    check(
      input.retry.previousAuthorizationDigest === guardianDigest(claims) &&
        claims.expiresAt <= Date.now() &&
        input.retry.observedAt >= claims.expiresAt &&
        input.retry.observedAt <= Date.now() &&
        Date.now() - input.retry.observedAt <= 30000 &&
        saved.aggregateVersion < 16,
    );
  } else check(!input.retry);
  const store =
    artifacts ??
    new R2GitHubArtifactStore(
      (
        (await getCloudflareContext({ async: true })).env as unknown as {
          HIVE_DELIVERY_EVIDENCE: EvidenceR2Bucket;
        }
      ).HIVE_DELIVERY_EVIDENCE,
    );
  check(store);
  const object = await store.readAndVerify(
    before.preservation.artifactKey,
    before.preservation.artifactDigest,
  );
  return db.$transaction(
    async (tx) => {
      await lockAccountMaintenanceWorkspace(tx, current.binding as unknown as RegistrationBinding);
      await tx.$queryRaw`SELECT id FROM codex_guardian_runtimes WHERE owner_id=${current.ownerId}::uuid AND id IN (${runtime.id}::uuid,${current.id}::uuid) ORDER BY id FOR UPDATE`;
      const freshCurrent = await tx.codexGuardianRuntime.findUniqueOrThrow({
          where: { id: current.id },
        }),
        freshClosed = await tx.codexGuardianRuntime.findUniqueOrThrow({
          where: { id: runtime.id },
        });
      check(
        guardianDigest(freshCurrent) === guardianDigest(current) &&
          guardianDigest(freshClosed) === guardianDigest(runtime),
      );
      await tx.$queryRaw`SELECT id FROM delivery_tasks WHERE owner_id=${current.ownerId}::uuid AND id=${before.taskId}::uuid FOR UPDATE`;
      const latest = await latestCheckoutClosure(
        tx,
        current.ownerId,
        ledgerId(input),
        "cleanup_authorized",
      );
      if (latest?.id !== saved?.id) {
        const existing = latest && checkoutCleanupClaimsSchema.parse(latest.payload);
        check(existing && exactRefreshReplay(existing));
        return { token: signCheckoutCleanup(existing, signingPem) };
      }
      const version = (latest?.aggregateVersion ?? 0) + 1;
      const after = await facts(tx, db, freshClosed, freshCurrent, input);
      check(guardianDigest(before) === guardianDigest(after));
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const issuedAt = clock.now.getTime();
      if (input.retry)
        check(input.retry.observedAt <= issuedAt && issuedAt - input.retry.observedAt <= 30000);
      check(issuedAt - volume.observedAt <= 30000 && issuedAt >= volume.observedAt);
      const base = {
        schemaVersion: 1,
        purpose: "managed-checkout-cleanup",
        authorizationId: current.id,
        ownerId: (current.binding as unknown as RegistrationBinding).ownerId,
        hiveUserId: current.ownerId,
        workspaceId: current.workspaceId,
        buildId: current.buildId,
        lifetimeId: current.lifetimeId,
        configSha256: current.configSha256,
        closedRuntimeId: runtime.id,
        closedLifetimeId: runtime.lifetimeId,
        barrierId: runtime.closedBarrierId,
        treeReceiptDigest: after.treeReceiptDigest,
        projectId: input.projectId,
        deliveryTaskId: after.taskId,
        binding: input.binding,
        sourceArchiveDigest: input.sourceArchiveDigest,
        controllerArchiveDigest: input.controllerArchiveDigest,
        preservationDigest: after.preservation.artifactDigest,
        leaseReleaseDigest: after.leaseReleaseDigest,
        completionEventId: after.completionEventIds[0],
        completionEventIds: after.completionEventIds,
        policyVersion: after.policyVersion,
        artifact: {
          key: after.preservation.artifactKey,
          digest: `sha256:${object.contentDigest}`,
          objectVersion: object.objectVersion,
          size: object.size,
        },
        productionObservation: {
          id: after.production.observationId,
          releaseId: after.production.releaseId,
          revision: input.binding.revision,
          mergeSha: after.production.mergeSha,
          sourceRevisionId: after.sourceRevisionId,
          buildDigest: after.production.buildDigest,
          observationDigest: after.production.observationDigest,
        },
        ...(input.retry
          ? {
              previousAuthorizationDigest: input.retry.previousAuthorizationDigest,
              refreshInspectionDigest: guardianDigest(input.retry),
            }
          : {}),
        currentVolume: volume,
        issuedAt,
        expiresAt: Math.min(issuedAt + 45000, authorizationUntil, policyUntil),
      };
      // First persist stable claims; authorization identity is this retained event.
      const identity = await retainCheckoutClosure(
        tx,
        { ownerId: current.ownerId, taskId: after.taskId, intentId: ledgerId(input) },
        "cleanup_identity",
        { binding: input.binding, closedRuntimeId: runtime.id },
        version,
      );
      const claims = checkoutCleanupClaimsSchema.parse({ ...base, authorizationId: identity.id });
      const event = await retainCheckoutClosure(
        tx,
        { ownerId: current.ownerId, taskId: after.taskId, intentId: ledgerId(input) },
        "cleanup_authorized",
        claims as unknown as Prisma.InputJsonObject,
        version,
      );
      check(claims.expiresAt > claims.issuedAt && event.requestDigest === guardianDigest(claims));
      const [last] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      check(
        last.now.getTime() < claims.expiresAt &&
          last.now.getTime() - volume.observedAt <= 30000 &&
          (!input.retry || last.now.getTime() - input.retry.observedAt <= 30000),
      );
      return { token: signCheckoutCleanup(claims, signingPem) };
    },
    { isolationLevel: "Serializable", timeout: 10000, maxWait: 2000 },
  );
}
/** Factual readback only: return an already-retained grant unchanged, including
 * its original expiry. Never collect preservation facts or mint authority. */
export async function readCheckoutCleanup(
  db: PrismaClient,
  current: CodexGuardianRuntime,
  raw: unknown,
  signingPem: string,
) {
  const input = checkoutCleanupRequestSchema.parse(raw);
  check(!input.retry);
  const closed = await db.codexGuardianRuntime.findFirst({
    where: {
      ownerId: current.ownerId,
      id: input.closedRuntimeId,
      workspaceId: current.workspaceId,
    },
  });
  check(closed);
  const saved = await latestCheckoutClosure(
    db,
    current.ownerId,
    ledgerId(input),
    "cleanup_authorized",
  );
  if (!saved) return { token: null };
  const claims = checkoutCleanupClaimsSchema.parse(saved.payload);
  check(
    claims.hiveUserId === current.ownerId &&
      claims.ownerId === (current.binding as unknown as RegistrationBinding).ownerId &&
      claims.workspaceId === current.workspaceId &&
      claims.buildId === current.buildId &&
      claims.lifetimeId === current.lifetimeId &&
      claims.configSha256 === current.configSha256 &&
      claims.projectId === input.projectId &&
      claims.closedRuntimeId === closed.id &&
      claims.closedLifetimeId === closed.lifetimeId &&
      guardianDigest(claims.binding) === guardianDigest(input.binding) &&
      claims.controllerArchiveDigest === input.controllerArchiveDigest &&
      claims.sourceArchiveDigest === input.sourceArchiveDigest,
  );
  return { token: signCheckoutCleanup(claims, signingPem) };
}
export async function acknowledgeCheckoutCleanup(
  db: PrismaClient,
  current: CodexGuardianRuntime,
  raw: unknown,
  projectId: string,
) {
  const receipt = checkoutCleanupReceiptSchema.parse(raw);
  const identity = await db.deliveryEvent.findFirst({
    where: {
      ownerId: current.ownerId,
      type: "checkout_cleanup_identity",
      id: receipt.authorizationId,
    },
  });
  check(identity);
  const prefix = "checkout-cleanup_identity/";
  check(identity.aggregateKey.startsWith(prefix));
  const id = identity.aggregateKey.slice(prefix.length);
  return db.$transaction(
    async (tx) => {
      const saved = await readCheckoutClosure(
        tx,
        current.ownerId,
        id,
        "cleanup_authorized",
        identity.aggregateVersion,
      );
      check(saved);
      const claims = checkoutCleanupClaimsSchema.parse(saved.payload);
      check(
        saved.taskId === identity.taskId &&
          claims.authorizationId === receipt.authorizationId &&
          guardianDigest(claims) === receipt.authorizationDigest &&
          claims.projectId === projectId &&
          claims.workspaceId === current.workspaceId &&
          claims.buildId === current.buildId &&
          claims.lifetimeId === current.lifetimeId &&
          receipt.cleanupRequestId === claims.binding.cleanupRequestId &&
          receipt.bindingDigest === guardianDigest(claims.binding) &&
          receipt.currentVolumeDigest === guardianDigest(claims.currentVolume),
      );
      await retainCheckoutClosure(
        tx,
        { ownerId: current.ownerId, taskId: saved.taskId, intentId: id },
        "cleanup_completed",
        receipt,
        identity.aggregateVersion,
      );
      return { cleanupRecorded: true, receiptDigest: guardianDigest(receipt) };
    },
    { isolationLevel: "Serializable" },
  );
}
