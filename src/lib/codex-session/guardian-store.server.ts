import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { type CodexGuardianRuntime, Prisma, type PrismaClient } from "@hive/db";
import { ProjectTaskIntents } from "@/lib/projects/task-intents.server";
import {
  type GuardianCheckout,
  type GuardianIdleSnapshot,
  type GuardianMetadataEvidence,
  type GuardianPolicy,
  type GuardianPreparation,
  type GuardianProducerAdmission,
  type GuardianProducerScope,
  guardianCheckoutSchema,
  guardianDeploymentPolicy,
  guardianDigest,
  guardianIdleSnapshotSchema,
  guardianMetadataEvidenceSchema,
  guardianPreparationSchema,
  preparationDigest,
  producerScopeSchema,
} from "./guardian-contracts";
import type { RegistrationBinding } from "./registration.server";
import { lockActiveRegistration, RegistrationRejected } from "./registration-store.server";

if (typeof window !== "undefined") throw new Error("Guardian storage is server-only.");
type Tx = Prisma.TransactionClient;
const requireGuardian: (value: unknown) => asserts value = (value) => {
  if (!value) throw new RegistrationRejected();
};

/** Acquire BEFORE intent/manager/task locks. Never cache this result or infer
 * producer approval from a host journal, unregistered preparation, or old ACK. */
export async function lockProducerAdmission(
  tx: Tx,
  rawScope: GuardianProducerScope,
  policy: GuardianPolicy = guardianDeploymentPolicy(),
): Promise<GuardianProducerAdmission> {
  requireGuardian(policy.enabled && policy.producerEnabled);
  const scope = producerScopeSchema.parse(rawScope);
  const { registration, slot, now } = await lockActiveRegistration(tx, {
    ownerId: scope.hiveUserId,
    registrationId: scope.registrationId,
  });
  requireGuardian(
    slot.workspaceId === scope.workspaceId &&
      registration.buildId === scope.buildId &&
      registration.serverInstanceId === scope.serverInstanceId,
  );
  const thread = registration.threads.find(
    (t) => t.projectId === scope.projectId && t.nativeThreadId === scope.managerThreadId,
  );
  requireGuardian(thread);
  // lockActiveRegistration independently derives/checks Coder owner from persisted
  // User/slot. No caller-provided Coder owner participates in this scope.
  const candidate = await tx.codexGuardianRuntime.findFirst({
    where: {
      ownerId: scope.hiveUserId,
      slotId: slot.id,
      phase: "open",
      workspaceId: scope.workspaceId,
      buildId: scope.buildId,
      serverInstanceId: scope.serverInstanceId,
    },
  });
  requireGuardian(candidate);
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM codex_guardian_runtimes WHERE owner_id=${scope.hiveUserId}::uuid AND id=${candidate.id}::uuid FOR UPDATE`;
  requireGuardian(locked.length === 1);
  const runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: scope.hiveUserId, id: candidate.id } },
  });
  requireGuardian(
    runtime.phase === "open" &&
      !runtime.closedBarrierId &&
      runtime.producerApproved &&
      runtime.authorityUntil > now &&
      runtime.nativeLaunchId &&
      runtime.hostKeyFingerprint === registration.hostKeyFingerprint &&
      policy.packages.some(
        (p) =>
          p.protocol === "guardian-v1" &&
          p.packageManifestSha256 === runtime.packageManifestSha256 &&
          p.guardianElfSha256 === runtime.guardianElfSha256 &&
          p.nodeSha256 === runtime.nodeSha256 &&
          p.policyDigest === runtime.policyDigest &&
          p.metadataPolicyDigest === runtime.metadataPolicyDigest,
      ),
  );
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM codex_guardian_admissions WHERE owner_id=${scope.hiveUserId}::uuid AND runtime_id=${runtime.id}::uuid AND project_id=${scope.projectId}::uuid FOR UPDATE`;
  requireGuardian(rows.length === 1);
  const admission = await tx.codexGuardianAdmission.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: scope.hiveUserId, id: rows[0].id } },
  });
  requireGuardian(
    admission.phase === "native" &&
      admission.registrationId === registration.id &&
      admission.nativeThreadId === scope.managerThreadId &&
      admission.preparationIntentId === scope.preparationIntentId &&
      admission.leaseId === scope.leaseId &&
      admission.leaseGeneration === scope.leaseGeneration &&
      admission.producerDigest &&
      admission.checkoutIncarnation,
  );
  const checkout = guardianCheckoutSchema.parse(admission.checkoutBinding);
  requireGuardian(
    checkout.projectId === scope.projectId &&
      checkout.preparationIntentId === scope.preparationIntentId &&
      checkout.repositoryId === scope.repositoryId &&
      checkout.leaseId === scope.leaseId &&
      checkout.leaseGeneration === scope.leaseGeneration &&
      checkout.checkoutIncarnation === admission.checkoutIncarnation,
  );
  const intents = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM project_task_intents WHERE owner_id=${scope.hiveUserId}::uuid AND project_id=${scope.projectId}::uuid AND id=${scope.preparationIntentId}::uuid FOR UPDATE`;
  requireGuardian(intents.length === 1);
  const intent = await tx.projectTaskIntent.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: scope.hiveUserId, id: scope.preparationIntentId } },
  });
  requireGuardian(
    intent.workspaceId === scope.workspaceId &&
      intent.repositoryId === scope.repositoryId &&
      intent.sourceSha === checkout.revision &&
      intent.requestDigest === admission.intentRequestDigest &&
      intent.phase !== "blocked",
  );
  const [time] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  requireGuardian(time && registration.expiresAt > time.now && runtime.authorityUntil > time.now);
  return {
    runtimeId: runtime.id,
    runtimeGeneration: runtime.generation,
    admissionId: admission.id,
    admissionGeneration: admission.generation,
    producerDigest: admission.producerDigest,
    checkoutIncarnation: admission.checkoutIncarnation,
    barrierGeneration: 0,
  };
}

export interface GuardianRuntimeIdentity {
  lifetimeId: string;
  bindingDigest: string;
  outerPublicKeyPem: string;
  packageManifestSha256: string;
  guardianElfSha256: string;
  nodeSha256: string;
  policyDigest: string;
  metadataPolicyDigest: string;
  configSha256: string;
}
export interface GuardianStoreOptions {
  policy: GuardianPolicy;
  encryptionKey: string;
  expectedConfigSha256(binding: RegistrationBinding): string;
  authorizationExpiresAt?: number;
  signal?: AbortSignal;
}
const bytesDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (pem: string) => {
  const key = createPublicKey(pem);
  requireGuardian(key.asymmetricKeyType === "ed25519");
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
};
async function databaseNow(tx: Tx) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  requireGuardian(row);
  return row.now;
}
async function lockGuardianSlot(tx: Tx, ownerId: string, slotId: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM codex_host_slots WHERE owner_id=${ownerId}::uuid AND id=${slotId}::uuid FOR UPDATE`;
  requireGuardian(rows.length === 1);
  const slot = await tx.codexHostSlot.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: slotId } },
  });
  const user = await tx.user.findUnique({ where: { id: ownerId } });
  requireGuardian(
    user && user.coderUserId === slot.coderOwnerId && user.coderUrl === slot.coderOrigin,
  );
  return slot;
}
async function lockGuardianRuntime(tx: Tx, ownerId: string, runtimeId: string) {
  const hint = await tx.codexGuardianRuntime.findUnique({
    where: { ownerId_id: { ownerId, id: runtimeId } },
  });
  requireGuardian(hint);
  const slot = await lockGuardianSlot(tx, ownerId, hint.slotId);
  if (slot.activeRegistrationId) {
    const registrations = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM codex_host_registrations WHERE owner_id=${ownerId}::uuid AND slot_id=${slot.id}::uuid AND id=${slot.activeRegistrationId}::uuid FOR UPDATE`;
    requireGuardian(registrations.length === 1);
  }
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM codex_guardian_runtimes WHERE owner_id=${ownerId}::uuid AND id=${runtimeId}::uuid FOR UPDATE`;
  requireGuardian(rows.length === 1);
  const runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: runtimeId } },
  });
  requireGuardian(runtime.workspaceId === slot.workspaceId);
  return { runtime, slot, now: await databaseNow(tx) };
}
async function lockGuardianAdmission(
  tx: Tx,
  ownerId: string,
  runtimeId: string,
  projectId: string,
) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM codex_guardian_admissions WHERE owner_id=${ownerId}::uuid AND runtime_id=${runtimeId}::uuid AND project_id=${projectId}::uuid FOR UPDATE`;
  requireGuardian(rows.length === 1);
  return tx.codexGuardianAdmission.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: rows[0].id } },
  });
}
async function lockAdmissionIntent(
  tx: Tx,
  runtime: CodexGuardianRuntime,
  admission: {
    ownerId: string;
    projectId: string;
    preparationIntentId: string;
    intentRequestDigest: string;
    preparation: Prisma.JsonValue;
  },
) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM project_task_intents WHERE owner_id=${admission.ownerId}::uuid AND project_id=${admission.projectId}::uuid AND id=${admission.preparationIntentId}::uuid FOR UPDATE`;
  requireGuardian(rows.length === 1);
  const intent = await tx.projectTaskIntent.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: admission.ownerId, id: admission.preparationIntentId } },
  });
  const preparation = guardianPreparationSchema.parse(admission.preparation);
  const project = await tx.deliveryProject.findUnique({
    where: { ownerId_id: { ownerId: admission.ownerId, id: admission.projectId } },
  });
  requireGuardian(
    intent.phase !== "blocked" &&
      intent.workspaceId === runtime.workspaceId &&
      intent.requestDigest === admission.intentRequestDigest &&
      intent.requestId === preparation.requestId &&
      intent.repositoryId === preparation.repositoryId &&
      intent.providerAccountId === preparation.providerAccountId &&
      intent.sourceSha === preparation.baseSha &&
      project?.provider === "github" &&
      project.providerRepositoryId === preparation.repositoryId &&
      project.providerAccountId === preparation.providerAccountId,
  );
  requireGuardian(runtime.authorityUntil > (await databaseNow(tx)));
  return intent;
}
function approvedRuntime(runtime: CodexGuardianRuntime, policy: GuardianPolicy) {
  requireGuardian(
    policy.enabled &&
      policy.packages.some(
        (p) =>
          p.protocol === "guardian-v1" &&
          p.packageManifestSha256 === runtime.packageManifestSha256 &&
          p.guardianElfSha256 === runtime.guardianElfSha256 &&
          p.nodeSha256 === runtime.nodeSha256 &&
          p.policyDigest === runtime.policyDigest &&
          p.metadataPolicyDigest === runtime.metadataPolicyDigest,
      ),
  );
}
function openRuntime(
  runtime: CodexGuardianRuntime,
  now: Date,
  generation: number,
  policy: GuardianPolicy,
) {
  approvedRuntime(runtime, policy);
  requireGuardian(
    runtime.phase === "open" &&
      !runtime.closedBarrierId &&
      runtime.generation === generation &&
      runtime.authorityUntil > now,
  );
}

/** Storage accepts only service-authenticated identity. Public routes must verify
 * outer proof + fresh owner/Coder scope before calling, including every fence. */
export class GuardianAdmissionStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: GuardianStoreOptions,
  ) {}
  private transaction<T>(work: (tx: Tx) => Promise<T>) {
    const assertCurrent = () => {
      this.options.signal?.throwIfAborted();
      if (this.options.authorizationExpiresAt !== undefined)
        requireGuardian(
          Number.isSafeInteger(this.options.authorizationExpiresAt) &&
            this.options.authorizationExpiresAt > Date.now(),
        );
    };
    return this.db.$transaction(
      async (tx) => {
        assertCurrent();
        const result = await work(tx);
        if (this.options.authorizationExpiresAt !== undefined) {
          const now = await databaseNow(tx);
          requireGuardian(now.getTime() < this.options.authorizationExpiresAt);
        }
        assertCurrent();
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      },
    );
  }
  async reserveRuntime(binding: RegistrationBinding, identity: GuardianRuntimeIdentity) {
    requireGuardian(
      this.options.policy.enabled &&
        identity.configSha256 === this.options.expectedConfigSha256(binding),
    );
    const keyFingerprint = fingerprint(identity.outerPublicKeyPem);
    return this.transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: binding.hiveUserId } });
      requireGuardian(
        user && user.coderUserId === binding.ownerId && user.coderUrl === binding.coderOrigin,
      );
      const candidate = await tx.codexHostSlot.upsert({
        where: {
          ownerId_coderOrigin_workspaceId_agentId: {
            ownerId: user.id,
            coderOrigin: binding.coderOrigin,
            workspaceId: binding.workspaceId,
            agentId: binding.agentId,
          },
        },
        create: {
          ownerId: user.id,
          coderOrigin: binding.coderOrigin,
          coderOwnerId: user.coderUserId,
          workspaceId: binding.workspaceId,
          agentId: binding.agentId,
        },
        update: {},
      });
      const slot = await lockGuardianSlot(tx, user.id, candidate.id);
      const existing = await tx.codexGuardianRuntime.findFirst({
        where: { ownerId: user.id, slotId: slot.id, phase: { not: "tree_closed" } },
      });
      if (existing) {
        requireGuardian(
          existing.lifetimeId === identity.lifetimeId &&
            existing.outerKeyFingerprint === keyFingerprint &&
            existing.bindingDigest === identity.bindingDigest &&
            existing.configSha256 === identity.configSha256 &&
            existing.buildId === binding.buildId &&
            existing.packageManifestSha256 === identity.packageManifestSha256 &&
            existing.guardianElfSha256 === identity.guardianElfSha256 &&
            existing.nodeSha256 === identity.nodeSha256 &&
            existing.policyDigest === identity.policyDigest &&
            existing.metadataPolicyDigest === identity.metadataPolicyDigest &&
            guardianDigest(existing.binding) === guardianDigest(binding),
        );
        approvedRuntime(existing, this.options.policy);
        return existing;
      }
      // No native registration can be retroactively reclassified as guardian-owned.
      requireGuardian(!slot.activeRegistrationId);
      const now = await databaseNow(tx);
      const row = await tx.codexGuardianRuntime.create({
        data: {
          ownerId: user.id,
          slotId: slot.id,
          ...identity,
          outerKeyFingerprint: keyFingerprint,
          binding: binding as unknown as Prisma.InputJsonObject,
          workspaceId: binding.workspaceId,
          buildId: binding.buildId,
          authorityUntil: new Date(now.getTime() + 60000),
        },
      });
      approvedRuntime(row, this.options.policy);
      return row;
    });
  }
  async sealGrant(input: {
    ownerId: string;
    runtimeId: string;
    id: string;
    tokenDigest: string;
    bindingDigest: string;
    issuedAt: Date;
    expiresAt: Date;
  }) {
    return this.transaction(async (tx) => {
      const { runtime, now } = await lockGuardianRuntime(tx, input.ownerId, input.runtimeId);
      approvedRuntime(runtime, this.options.policy);
      requireGuardian(
        runtime.phase === "reserved" &&
          input.issuedAt <= now &&
          input.expiresAt > now &&
          input.expiresAt.getTime() - input.issuedAt.getTime() <= 60000,
      );
      return tx.codexGuardianEnrollmentGrant.create({ data: input });
    });
  }
  async enroll(input: {
    ownerId: string;
    runtimeId: string;
    grantId: string;
    tokenDigest: string;
    bindingDigest: string;
    consumptionDigest: string;
  }) {
    return this.transaction(async (tx) => {
      const { runtime, now } = await lockGuardianRuntime(tx, input.ownerId, input.runtimeId);
      approvedRuntime(runtime, this.options.policy);
      const grant = await tx.codexGuardianEnrollmentGrant.findUnique({
        where: { ownerId_id: { ownerId: input.ownerId, id: input.grantId } },
      });
      requireGuardian(
        grant &&
          grant.runtimeId === runtime.id &&
          grant.tokenDigest === input.tokenDigest &&
          grant.bindingDigest === input.bindingDigest &&
          grant.issuedAt <= now &&
          grant.expiresAt > now &&
          !grant.consumedAt &&
          runtime.phase === "reserved",
      );
      await tx.codexGuardianEnrollmentGrant.update({
        where: { id: grant.id },
        data: { consumedAt: now, consumptionDigest: input.consumptionDigest },
      });
      return tx.codexGuardianRuntime.update({
        where: { id: runtime.id },
        data: { phase: "open", enrolledAt: now, authorityUntil: new Date(now.getTime() + 180000) },
      });
    });
  }
  async prepare(input: {
    ownerId: string;
    runtimeId: string;
    runtimeGeneration: number;
    preparation: GuardianPreparation;
    preparationDigest: string;
  }) {
    const preparation = guardianPreparationSchema.parse(input.preparation);
    requireGuardian(preparationDigest(preparation) === input.preparationDigest);
    return this.transaction(async (tx) => {
      const { runtime, slot, now } = await lockGuardianRuntime(tx, input.ownerId, input.runtimeId);
      openRuntime(runtime, now, input.runtimeGeneration, this.options.policy);
      requireGuardian(
        !runtime.nativeLaunchId &&
          preparation.ownerId === slot.coderOwnerId &&
          preparation.workspaceId === runtime.workspaceId &&
          preparation.buildId === runtime.buildId,
      );
      const existing = await tx.codexGuardianAdmission.findUnique({
        where: {
          ownerId_runtimeId_projectId: {
            ownerId: input.ownerId,
            runtimeId: runtime.id,
            projectId: preparation.projectId,
          },
        },
      });
      if (existing) {
        await lockAdmissionIntent(tx, runtime, existing);
        requireGuardian(
          existing.preparationDigest === input.preparationDigest &&
            guardianDigest(existing.preparation) === guardianDigest(preparation),
        );
        return { runtime, admission: existing, replayed: true };
      }
      const held = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM project_task_intents WHERE owner_id=${input.ownerId}::uuid AND project_id=${preparation.projectId}::uuid AND id=${preparation.taskId}::uuid FOR UPDATE`;
      requireGuardian(held.length === 1);
      const intent = await tx.projectTaskIntent.findUniqueOrThrow({
        where: { ownerId_id: { ownerId: input.ownerId, id: preparation.taskId } },
      });
      const project = await tx.deliveryProject.findUnique({
        where: { ownerId_id: { ownerId: input.ownerId, id: preparation.projectId } },
      });
      requireGuardian(
        project &&
          project.provider === "github" &&
          project.providerRepositoryId === preparation.repositoryId &&
          project.providerAccountId === preparation.providerAccountId &&
          intent.workspaceId === runtime.workspaceId &&
          intent.requestId === preparation.requestId &&
          intent.repositoryId === preparation.repositoryId &&
          intent.providerAccountId === preparation.providerAccountId &&
          intent.sourceSha === preparation.baseSha &&
          ["queued", "preparing"].includes(intent.phase),
      );
      const payload = new ProjectTaskIntents(this.db, this.options.encryptionKey).payload(intent);
      requireGuardian(
        bytesDigest(JSON.stringify(payload.hostRequest)) === preparation.requestDigest,
      );
      const count = await tx.codexGuardianAdmission.count({
        where: { ownerId: input.ownerId, runtimeId: runtime.id },
      });
      requireGuardian(count < 32);
      const admission = await tx.codexGuardianAdmission.create({
        data: {
          ownerId: input.ownerId,
          runtimeId: runtime.id,
          projectId: preparation.projectId,
          preparationIntentId: intent.id,
          preparationDigest: input.preparationDigest,
          preparation,
          intentRequestDigest: intent.requestDigest,
        },
      });
      const updated = await tx.codexGuardianRuntime.update({
        where: { id: runtime.id },
        data: { generation: { increment: 1 }, authorityUntil: new Date(now.getTime() + 180000) },
      });
      return { runtime: updated, admission, replayed: false };
    });
  }
  async bindCheckout(input: {
    ownerId: string;
    runtimeId: string;
    runtimeGeneration: number;
    checkout: GuardianCheckout;
  }) {
    const checkout = guardianCheckoutSchema.parse(input.checkout);
    return this.transaction(async (tx) => {
      const { runtime, now } = await lockGuardianRuntime(tx, input.ownerId, input.runtimeId);
      openRuntime(runtime, now, input.runtimeGeneration, this.options.policy);
      requireGuardian(!runtime.nativeLaunchId);
      const admission = await lockGuardianAdmission(
        tx,
        input.ownerId,
        runtime.id,
        checkout.projectId,
      );
      await lockAdmissionIntent(tx, runtime, admission);
      const preparation = guardianPreparationSchema.parse(admission.preparation);
      requireGuardian(
        admission.preparationIntentId === checkout.preparationIntentId &&
          preparation.repositoryId === checkout.repositoryId &&
          preparation.baseSha === checkout.revision,
      );
      if (admission.checkoutBinding) {
        requireGuardian(guardianDigest(admission.checkoutBinding) === guardianDigest(checkout));
        return { runtime, admission, replayed: true };
      }
      requireGuardian(admission.phase === "preparation");
      const next = await tx.codexGuardianAdmission.update({
        where: { id: admission.id },
        data: {
          phase: "checkout",
          generation: { increment: 1 },
          checkoutBinding: checkout,
          checkoutBindingDigest: guardianDigest(checkout),
          checkoutIncarnation: checkout.checkoutIncarnation,
          leaseId: checkout.leaseId,
          leaseGeneration: checkout.leaseGeneration,
          checkoutBoundAt: now,
        },
      });
      return { runtime, admission: next, replayed: false };
    });
  }
  async reserveNativeLaunch(input: {
    ownerId: string;
    runtimeId: string;
    runtimeGeneration: number;
    nativeLaunchId: string;
    launchIntentDigest: string;
    projectIds: string[];
  }) {
    return this.transaction(async (tx) => {
      const { runtime, now } = await lockGuardianRuntime(tx, input.ownerId, input.runtimeId);
      openRuntime(runtime, now, input.runtimeGeneration, this.options.policy);
      requireGuardian(!runtime.nativeLaunchId && this.options.policy.producerEnabled);
      const projects = [...input.projectIds].sort();
      requireGuardian(
        projects.length > 0 && projects.length <= 32 && new Set(projects).size === projects.length,
      );
      const admissions = [];
      for (const projectId of projects)
        admissions.push(await lockGuardianAdmission(tx, input.ownerId, runtime.id, projectId));
      const count = await tx.codexGuardianAdmission.count({
        where: { ownerId: input.ownerId, runtimeId: runtime.id },
      });
      requireGuardian(
        count === projects.length &&
          admissions.every((a) => a.phase === "checkout" && a.checkoutBinding),
      );
      for (const a of admissions) {
        await lockAdmissionIntent(tx, runtime, a);
        const holds = await tx.deliveryManagerBinding.findMany({
          where: { ownerId: input.ownerId, preparationIntentId: a.preparationIntentId },
          select: { id: true, activeAttemptId: true, blockedReason: true },
        });
        requireGuardian(holds.length === 0); // First native launch; never adopt an earlier physical writer.
        const priorThreads = await tx.codexRegisteredThread.findMany({
          where: { ownerId: input.ownerId, projectId: a.projectId },
          select: { registrationId: true },
        });
        for (const thread of priorThreads) {
          const closed = await tx.codexGuardianAdmission.findFirst({
            where: {
              ownerId: input.ownerId,
              projectId: a.projectId,
              registrationId: thread.registrationId,
              runtime: { phase: "tree_closed" },
            },
            select: { id: true },
          });
          requireGuardian(closed); // Revocation/expiry or an empty manager table is not tree-exit evidence.
        }
      }
      const inventory = admissions.map((a) => ({
        admissionId: a.id,
        admissionGeneration: a.generation,
        checkout: guardianCheckoutSchema.parse(a.checkoutBinding),
      }));
      const expected = guardianDigest({
        runtimeId: runtime.id,
        runtimeGeneration: runtime.generation,
        nativeLaunchId: input.nativeLaunchId,
        inventory,
      });
      requireGuardian(expected === input.launchIntentDigest);
      openRuntime(runtime, await databaseNow(tx), input.runtimeGeneration, this.options.policy);
      await tx.codexGuardianRuntime.update({
        where: { id: runtime.id },
        data: {
          nativeLaunchId: input.nativeLaunchId,
          nativeLaunchDigest: expected,
          nativeLaunchAt: now,
        },
      });
      return {
        runtimeId: runtime.id,
        runtimeGeneration: runtime.generation,
        policyDigest: runtime.policyDigest,
        metadataPolicyDigest: runtime.metadataPolicyDigest,
        nativeLaunchId: input.nativeLaunchId,
        launchIntentDigest: expected,
        approvals: inventory.map(({ admissionId, admissionGeneration, checkout }) => ({
          projectId: checkout.projectId,
          repositoryId: checkout.repositoryId,
          taskId: checkout.preparationIntentId,
          leaseId: checkout.leaseId,
          leaseGeneration: checkout.leaseGeneration,
          checkoutIncarnation: checkout.checkoutIncarnation,
          checkoutIdentity: checkout.checkoutIdentity,
          revision: checkout.revision,
          admissionId,
          admissionGeneration,
          firstNative: true as const,
        })),
      };
    });
  }
  async finalizeNative(input: {
    scope: GuardianProducerScope;
    runtimeId: string;
    runtimeGeneration: number;
    metadata: GuardianMetadataEvidence;
  }) {
    const metadata = guardianMetadataEvidenceSchema.parse(input.metadata);
    const scope = producerScopeSchema.parse(input.scope);
    return this.transaction(async (tx) => {
      const { registration, slot, now } = await lockActiveRegistration(tx, {
        ownerId: scope.hiveUserId,
        registrationId: scope.registrationId,
      });
      const { runtime } = await lockGuardianRuntime(tx, scope.hiveUserId, input.runtimeId);
      openRuntime(runtime, await databaseNow(tx), input.runtimeGeneration, this.options.policy);
      requireGuardian(
        this.options.policy.producerEnabled &&
          (!runtime.serverInstanceId || runtime.producerApproved),
      );
      requireGuardian(
        runtime.nativeLaunchId &&
          runtime.slotId === slot.id &&
          runtime.workspaceId === scope.workspaceId &&
          runtime.buildId === scope.buildId &&
          registration.buildId === scope.buildId &&
          registration.serverInstanceId === scope.serverInstanceId &&
          registration.threads.some(
            (t) => t.projectId === scope.projectId && t.nativeThreadId === scope.managerThreadId,
          ) &&
          (!runtime.serverInstanceId || runtime.serverInstanceId === scope.serverInstanceId) &&
          (!runtime.hostKeyFingerprint ||
            runtime.hostKeyFingerprint === registration.hostKeyFingerprint),
      );
      const admission = await lockGuardianAdmission(
        tx,
        scope.hiveUserId,
        runtime.id,
        scope.projectId,
      );
      await lockAdmissionIntent(tx, runtime, admission);
      requireGuardian(registration.expiresAt > (await databaseNow(tx)));
      const checkout = guardianCheckoutSchema.parse(admission.checkoutBinding);
      requireGuardian(
        metadata.nativeLaunchId === runtime.nativeLaunchId &&
          metadata.launchIntentDigest === runtime.nativeLaunchDigest &&
          metadata.metadataPolicyDigest === runtime.metadataPolicyDigest &&
          guardianDigest(metadata.pins.checkout) === guardianDigest(checkout.checkoutIdentity),
      );
      requireGuardian(
        checkout.preparationIntentId === scope.preparationIntentId &&
          checkout.repositoryId === scope.repositoryId &&
          checkout.leaseId === scope.leaseId &&
          checkout.leaseGeneration === scope.leaseGeneration,
      );
      if (admission.phase === "native") {
        requireGuardian(
          admission.registrationId === registration.id &&
            admission.nativeThreadId === scope.managerThreadId &&
            admission.metadataPinsDigest === guardianDigest(metadata) &&
            guardianDigest(admission.metadataPins) === guardianDigest(metadata),
        );
        return { runtime, admission, replayed: true };
      }
      requireGuardian(admission.phase === "checkout" && this.options.policy.producerEnabled);
      const producerDigest = guardianDigest({
        runtimeId: runtime.id,
        admissionId: admission.id,
        registrationId: registration.id,
        hostKeyFingerprint: registration.hostKeyFingerprint,
        scope,
        checkout,
        policyDigest: runtime.policyDigest,
        metadataPolicyDigest: runtime.metadataPolicyDigest,
        metadata,
      });
      const next = await tx.codexGuardianAdmission.update({
        where: { id: admission.id },
        data: {
          phase: "native",
          generation: { increment: 1 },
          registrationId: registration.id,
          nativeThreadId: scope.managerThreadId,
          producerDigest,
          metadataPins: metadata,
          metadataPinsDigest: guardianDigest(metadata),
          nativeBoundAt: now,
        },
      });
      const updated = await tx.codexGuardianRuntime.update({
        where: { id: runtime.id },
        data: {
          serverInstanceId: scope.serverInstanceId,
          hostKeyFingerprint: registration.hostKeyFingerprint,
          producerApproved: true,
          authorityUntil: new Date(now.getTime() + 180000),
        },
      });
      return { runtime: updated, admission: next, replayed: false };
    });
  }
  async fence(input: {
    ownerId: string;
    runtimeId: string;
    runtimeGeneration: number;
    projectId: string;
    preparationDigest: string;
  }) {
    return this.transaction(async (tx) => {
      const { runtime, now } = await lockGuardianRuntime(tx, input.ownerId, input.runtimeId);
      openRuntime(runtime, now, input.runtimeGeneration, this.options.policy);
      const admission = await lockGuardianAdmission(tx, input.ownerId, runtime.id, input.projectId);
      requireGuardian(admission.preparationDigest === input.preparationDigest);
      await lockAdmissionIntent(tx, runtime, admission);
      if (admission.phase === "native") {
        requireGuardian(this.options.policy.producerEnabled && runtime.producerApproved);
        requireGuardian(admission.registrationId && admission.nativeThreadId);
        const active = await lockActiveRegistration(tx, {
          ownerId: input.ownerId,
          registrationId: admission.registrationId,
        });
        requireGuardian(
          active.registration.serverInstanceId === runtime.serverInstanceId &&
            active.registration.hostKeyFingerprint === runtime.hostKeyFingerprint &&
            active.registration.buildId === runtime.buildId &&
            active.registration.threads.some(
              (t) =>
                t.projectId === admission.projectId &&
                t.nativeThreadId === admission.nativeThreadId,
            ),
        );
        requireGuardian(active.registration.expiresAt > (await databaseNow(tx)));
      }
      const fresh = await databaseNow(tx);
      requireGuardian(runtime.authorityUntil > fresh);
      const updated = await tx.codexGuardianRuntime.update({
        where: { id: runtime.id },
        data: { authorityUntil: new Date(fresh.getTime() + 180000) },
      });
      return { runtime: updated, admission };
    });
  }
  async closeBarrier(input: {
    ownerId: string;
    runtimeId: string;
    runtimeGeneration: number;
    barrierId: string;
    ownershipDigest: string;
    projectBindings: { projectId: string; bindingDigest: string }[];
    snapshots: GuardianIdleSnapshot[];
  }) {
    const snapshots = input.snapshots.map((s) => guardianIdleSnapshotSchema.parse(s));
    requireGuardian(/^[a-f0-9]{64}$/.test(input.ownershipDigest) && snapshots.length <= 32);
    return this.transaction(async (tx) => {
      const { runtime, slot, now } = await lockGuardianRuntime(tx, input.ownerId, input.runtimeId);
      approvedRuntime(runtime, this.options.policy);
      requireGuardian(
        runtime.phase === "open" &&
          !runtime.closedBarrierId &&
          runtime.generation === input.runtimeGeneration,
      );
      const projects = [...input.projectBindings].sort((a, b) =>
        a.projectId.localeCompare(b.projectId),
      );
      const all = await tx.codexGuardianAdmission.findMany({
        where: { ownerId: input.ownerId, runtimeId: runtime.id },
        orderBy: { projectId: "asc" },
      });
      requireGuardian(
        projects.length === all.length &&
          new Set(projects.map((p) => p.projectId)).size === all.length &&
          snapshots.length === all.length,
      );
      const decisions: {
        admissionId: string;
        admissionGeneration: number;
        state: Prisma.InputJsonObject;
        stateDigest: string;
      }[] = [];
      for (const candidate of all) {
        const admission = await lockGuardianAdmission(
          tx,
          input.ownerId,
          runtime.id,
          candidate.projectId,
        );
        requireGuardian(
          admission.phase === "native" &&
            projects.some(
              (p) =>
                p.projectId === admission.projectId &&
                p.bindingDigest === admission.preparationDigest,
            ),
        );
        const observation = snapshots.find((s) => s.projectId === admission.projectId);
        requireGuardian(
          observation &&
            observation.admissionId === admission.id &&
            observation.admissionGeneration === admission.generation &&
            observation.managerThreadId === admission.nativeThreadId &&
            Date.parse(observation.observedAt) <= now.getTime() &&
            now.getTime() - Date.parse(observation.observedAt) <= 5000,
        );
        requireGuardian(
          admission.registrationId === slot.activeRegistrationId && admission.registrationId,
        );
        const active = await lockActiveRegistration(tx, {
          ownerId: input.ownerId,
          registrationId: admission.registrationId,
        });
        requireGuardian(
          active.registration.buildId === runtime.buildId &&
            active.registration.serverInstanceId === runtime.serverInstanceId &&
            active.registration.hostKeyFingerprint === runtime.hostKeyFingerprint &&
            active.registration.threads.some(
              (t) =>
                t.projectId === admission.projectId &&
                t.nativeThreadId === admission.nativeThreadId,
            ),
        );
        await lockAdmissionIntent(tx, runtime, admission);
        const bindings = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM delivery_manager_bindings WHERE owner_id=${input.ownerId}::uuid AND preparation_intent_id=${admission.preparationIntentId}::uuid ORDER BY id FOR UPDATE`;
        requireGuardian(bindings.length === 1 && bindings[0].id === observation.managerBindingId);
        const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
          where: { ownerId_id: { ownerId: input.ownerId, id: bindings[0].id } },
        });
        requireGuardian(
          !binding.blockedReason &&
            binding.serverInstanceId === runtime.serverInstanceId &&
            binding.nativeThreadId === admission.nativeThreadId &&
            binding.currentAttemptId === observation.currentAttemptId &&
            binding.cursorVersion === observation.cursorVersion &&
            binding.nativeSequence === observation.nativeSequence,
        );
        const taskLocks = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM delivery_tasks WHERE owner_id=${input.ownerId}::uuid AND manager_binding_id=${binding.id}::uuid ORDER BY id FOR UPDATE`;
        requireGuardian(taskLocks.length > 0 && taskLocks.length <= 32);
        const tasks = await tx.deliveryTask.findMany({
          where: { ownerId: input.ownerId, managerBindingId: binding.id },
          include: { steps: { include: { attempts: true } } },
        });
        requireGuardian(
          tasks.every(
            (task) =>
              task.steps.length > 0 &&
              task.steps.every(
                (step) =>
                  step.state === "succeeded" ||
                  (step.state === "reported" &&
                    step.kind === "understand" &&
                    step.requiredEvidenceKinds.length === 1 &&
                    step.requiredEvidenceKinds[0] === "analysis"),
              ),
          ),
        );
        for (const task of tasks)
          for (const step of task.steps)
            for (const attempt of step.attempts) {
              requireGuardian(attempt.outcome !== "running");
              if (attempt.runtimeBindingDigest) {
                const terminal = await tx.deliveryEvent.findFirst({
                  where: {
                    ownerId: input.ownerId,
                    attemptId: attempt.id,
                    type: { in: ["native_attempt_observed", "native_source_conflict"] },
                  },
                  orderBy: { aggregateVersion: "desc" },
                });
                const payload = terminal?.payload as {
                  nativeSourceKind?: unknown;
                  turnStatus?: unknown;
                } | null;
                requireGuardian(
                  terminal?.type === "native_attempt_observed" &&
                    payload?.nativeSourceKind === "turn_completed" &&
                    ["completed", "failed", "interrupted"].includes(String(payload.turnStatus)),
                );
              }
            }
        const currentClaim = await tx.deliveryEvent.findFirst({
          where: {
            ownerId: input.ownerId,
            attemptId: binding.currentAttemptId,
            type: "attempt_started",
          },
        });
        const nativeClaim = (
          currentClaim?.payload as {
            nativeClaim?: { managerThreadId?: unknown; parentTurnId?: unknown };
          } | null
        )?.nativeClaim;
        requireGuardian(
          nativeClaim?.managerThreadId === admission.nativeThreadId &&
            nativeClaim.parentTurnId === observation.parentTurnId,
        );
        const grants = await tx.deliveryEvent.findMany({
          where: {
            ownerId: input.ownerId,
            taskId: { in: tasks.map((t) => t.id) },
            type: "source_publication_grant",
          },
        });
        for (const grant of grants) {
          const consumed = await tx.deliveryEvent.findFirst({
            where: {
              ownerId: input.ownerId,
              taskId: grant.taskId,
              type: "source_publication_consumed",
              payload: { path: ["challengeId"], equals: grant.id },
            },
          });
          requireGuardian(consumed); // Expiry/revocation alone cannot prove no external effect.
        }
        const state = {
          bindingId: binding.id,
          cursorVersion: binding.cursorVersion,
          nativeSequence: binding.nativeSequence,
          activeAttemptId: binding.activeAttemptId,
          currentAttemptId: binding.currentAttemptId,
          checkoutBinding: admission.checkoutBinding,
          producerDigest: admission.producerDigest,
          metadataPinsDigest: admission.metadataPinsDigest,
          taskVersions: tasks.map((t) => ({
            id: t.id,
            version: t.version,
            sourceVersion: t.sourceVersion,
          })),
          observation,
        } as Prisma.InputJsonObject;
        decisions.push({
          admissionId: admission.id,
          admissionGeneration: admission.generation,
          state,
          stateDigest: guardianDigest(state),
        });
      }
      const fresh = await databaseNow(tx);
      requireGuardian(
        snapshots.every(
          (s) =>
            Date.parse(s.observedAt) <= fresh.getTime() &&
            fresh.getTime() - Date.parse(s.observedAt) <= 5000,
        ),
      );
      const generation = runtime.generation + 1;
      const requestDigest = guardianDigest(input);
      await tx.codexGuardianBarrier.create({
        data: {
          id: input.barrierId,
          ownerId: input.ownerId,
          runtimeId: runtime.id,
          generation,
          ownershipDigest: input.ownershipDigest,
          requestDigest,
          closedAt: fresh,
        },
      });
      const rows = [];
      for (const decision of decisions)
        rows.push(
          await tx.codexGuardianStopDecision.create({
            data: {
              id: randomUUID(),
              ownerId: input.ownerId,
              runtimeId: runtime.id,
              barrierId: input.barrierId,
              ...decision,
              decidedAt: fresh,
            },
          }),
        );
      await tx.codexGuardianRuntime.update({
        where: { id: runtime.id },
        data: { phase: "barrier_closed", generation, closedBarrierId: input.barrierId },
      });
      return {
        runtimeId: runtime.id,
        runtimeGeneration: generation,
        barrierId: input.barrierId,
        ownershipDigest: input.ownershipDigest,
        decisions: rows.map((r) => ({
          admissionId: r.admissionId,
          admissionGeneration: r.admissionGeneration,
          decisionId: r.id,
          stateDigest: r.stateDigest,
        })),
        treeExited: false,
        cleanupAuthorized: false,
      };
    });
  }
}

export async function lockProducerMetadata(
  tx: Tx,
  scope: GuardianProducerScope,
  policy: GuardianPolicy = guardianDeploymentPolicy(),
) {
  const authority = await lockProducerAdmission(tx, scope, policy);
  const admission = await tx.codexGuardianAdmission.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: scope.hiveUserId, id: authority.admissionId } },
  });
  const metadata = guardianMetadataEvidenceSchema.parse(admission.metadataPins);
  requireGuardian(admission.metadataPinsDigest === guardianDigest(metadata));
  const checkout = guardianCheckoutSchema.parse(admission.checkoutBinding);
  requireGuardian(
    guardianDigest(metadata.pins.checkout) === guardianDigest(checkout.checkoutIdentity),
  );
  return {
    ...authority,
    metadataPins: metadata.pins,
    metadataPinsDigest: admission.metadataPinsDigest,
    metadataPolicyDigest: metadata.metadataPolicyDigest,
    namespaceReceiptDigest: metadata.namespaceReceiptDigest,
  };
}
