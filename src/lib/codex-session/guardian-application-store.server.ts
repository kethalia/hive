import { type DeliverySourceApplication, Prisma, type PrismaClient } from "@hive/db";
import type { SourceContext } from "@/lib/delivery/contracts";
import { resolveTaskSource } from "@/lib/delivery/source-resolver.server";
import { DeliveryConflict } from "@/lib/delivery/state";
import {
  type GuardianApplicationReceipt,
  type GuardianApplicationReservation,
  guardianApplicationAuthoritySchema,
  guardianApplicationReceiptSchema,
  guardianApplicationReservationSchema,
} from "./guardian-application-contracts";
import {
  type GuardianPolicy,
  type GuardianProducerScope,
  guardianDigest,
  producerScopeSchema,
} from "./guardian-contracts";
import { lockProducerMetadata } from "./guardian-store.server";
import { RegistrationRejected } from "./registration-store.server";

if (typeof window !== "undefined") throw new Error("Source application storage is server-only.");
type Tx = Prisma.TransactionClient;
const requireCurrent: (v: unknown) => asserts v = (v) => {
  if (!v) throw new RegistrationRejected();
};
const same = (a: unknown, b: unknown) => guardianDigest(a) === guardianDigest(b);
const now = async (tx: Tx) =>
  (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
const context = (v: { id: string; version: number; headSha: string }): SourceContext => ({
  revisionId: v.id,
  version: v.version,
  headSha: v.headSha,
});
const storedRoot = (row: DeliverySourceApplication) =>
  row.idleSnapshot as unknown as {
    native: GuardianApplicationReservation["idleSnapshot"];
    physicalAnchorAttemptId: string;
  };

/** Only a service-authenticated approved outer may call this store. In particular,
 * receipt digests are its typed attestation of independently verified fixed local
 * journals; the server never receives local HMAC keys or treats raw HEAD hashes as
 * a grant. This class has no installed factory or network activation. */
export class GuardianSourceApplicationStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: {
      policy: GuardianPolicy;
      expectedRuntime: { id: string; generation: number };
      signal?: AbortSignal;
      authorizationExpiresAt?: number;
    },
  ) {}
  private async transaction<T extends { expiresAt: number }>(
    raw: GuardianProducerScope,
    work: (
      tx: Tx,
      scope: GuardianProducerScope,
      producer: Awaited<ReturnType<typeof lockProducerMetadata>>,
    ) => Promise<T>,
  ) {
    const scope = producerScopeSchema.parse(raw),
      active = () => {
        this.options.signal?.throwIfAborted();
        if (this.options.authorizationExpiresAt !== undefined)
          requireCurrent(this.options.authorizationExpiresAt > Date.now());
      };
    active();
    return this.db.$transaction(
      async (tx) => {
        active();
        // Existing lock order is slot/registration -> runtime -> admission -> intent.
        // Application/manager/task locks always FOLLOW this shared identity lock.
        const producer = await lockProducerMetadata(tx, scope, this.options.policy);
        requireCurrent(
          producer.runtimeId === this.options.expectedRuntime.id &&
            producer.runtimeGeneration === this.options.expectedRuntime.generation,
        );
        const result = await work(tx, scope, producer);
        const runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({
          where: { id: producer.runtimeId },
        });
        const registration = await tx.codexHostRegistration.findUniqueOrThrow({
          where: { id: scope.registrationId },
        });
        const time = await now(tx);
        if (this.options.authorizationExpiresAt !== undefined)
          requireCurrent(time.getTime() < this.options.authorizationExpiresAt);
        requireCurrent(runtime.authorityUntil > time && registration.expiresAt > time);
        requireCurrent(result.expiresAt * 1000 > time.getTime());
        active();
        return result;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
        maxWait: 10000,
      },
    );
  }
  private async manager(tx: Tx, scope: GuardianProducerScope) {
    const found = await tx.deliveryManagerBinding.findFirst({
      where: {
        ownerId: scope.hiveUserId,
        projectId: scope.projectId,
        preparationIntentId: scope.preparationIntentId,
        workspaceId: scope.workspaceId,
        buildId: scope.buildId,
        serverInstanceId: scope.serverInstanceId,
        nativeThreadId: scope.managerThreadId,
        repositoryId: scope.repositoryId,
        leaseId: scope.leaseId,
        leaseGeneration: scope.leaseGeneration,
      },
    });
    requireCurrent(found);
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_manager_bindings WHERE owner_id=${scope.hiveUserId}::uuid AND id=${found.id}::uuid FOR UPDATE`;
    requireCurrent(rows.length === 1);
    const manager = await tx.deliveryManagerBinding.findUniqueOrThrow({ where: { id: found.id } });
    requireCurrent(
      manager.progressionProtocol === 1 &&
        manager.activeAttemptId &&
        manager.currentAttemptId &&
        !manager.blockedReason,
    );
    return manager;
  }
  private async accepted(
    tx: Tx,
    scope: GuardianProducerScope,
    manager: Awaited<ReturnType<GuardianSourceApplicationStore["manager"]>>,
    operationId: string,
  ) {
    const target = await tx.deliverySourceRevision.findUnique({
      where: {
        ownerId_managerBindingId_operationId: {
          ownerId: scope.hiveUserId,
          managerBindingId: manager.id,
          operationId,
        },
      },
    });
    requireCurrent(target);
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_tasks WHERE owner_id=${scope.hiveUserId}::uuid AND id=${target.taskId}::uuid FOR UPDATE`;
    requireCurrent(rows.length === 1);
    const source = await resolveTaskSource(tx, scope.hiveUserId, target.taskId);
    const attempt = await tx.deliveryAttempt.findUnique({
      where: { id: target.producingAttemptId },
      include: { step: true },
    });
    requireCurrent(
      source.task.managerBindingId === manager.id &&
        source.task.projectId === scope.projectId &&
        source.task.sourceRevisionId === target.id &&
        target.producer === "protected-source-broker-v1" &&
        target.repositoryId === scope.repositoryId &&
        target.inputSha === attempt?.sourceSha &&
        attempt?.ownerId === scope.hiveUserId &&
        attempt.managerBindingId === manager.id &&
        attempt.stepId === target.stepId &&
        attempt.step.taskId === target.taskId &&
        attempt.outputRevisionId === target.id &&
        manager.currentAttemptId === attempt.id &&
        ["reported", "succeeded"].includes(attempt.outcome) &&
        attempt.step.state === attempt.outcome,
    );
    const claim = await tx.deliveryEvent.findFirst({
      where: { ownerId: scope.hiveUserId, attemptId: attempt.id, type: "attempt_started" },
    });
    const nativeClaim = (
      claim?.payload as {
        nativeClaim?: {
          managerThreadId?: unknown;
          parentTurnId?: unknown;
          cursorVersion?: unknown;
        };
      } | null
    )?.nativeClaim;
    requireCurrent(
      nativeClaim?.managerThreadId === scope.managerThreadId &&
        nativeClaim.cursorVersion === manager.cursorVersion &&
        typeof nativeClaim.parentTurnId === "string",
    );
    // No logical attempt lease check: metadata application follows root completion,
    // while the original physical writer anchor and native lifetime remain held.
    return { target, source, attempt, parentTurnId: nativeClaim.parentTurnId };
  }
  private async row(tx: Tx, scope: GuardianProducerScope, applicationId: string) {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_source_applications WHERE owner_id=${scope.hiveUserId}::uuid AND id=${applicationId}::uuid FOR UPDATE`;
    requireCurrent(rows.length === 1);
    const row = await tx.deliverySourceApplication.findUniqueOrThrow({
      where: { id: applicationId },
    });
    requireCurrent(
      row.registrationId === scope.registrationId &&
        row.serverInstanceId === scope.serverInstanceId &&
        row.managerThreadId === scope.managerThreadId,
    );
    return row;
  }
  private assertProducer(
    row: DeliverySourceApplication,
    producer: Awaited<ReturnType<typeof lockProducerMetadata>>,
  ) {
    requireCurrent(
      row.runtimeId === producer.runtimeId &&
        row.runtimeGeneration === producer.runtimeGeneration &&
        row.admissionId === producer.admissionId &&
        row.admissionGeneration === producer.admissionGeneration &&
        row.producerDigest === producer.producerDigest &&
        row.metadataPinsDigest === producer.metadataPinsDigest &&
        row.namespaceReceiptDigest === producer.namespaceReceiptDigest &&
        producer.barrierGeneration === 0,
    );
  }
  private async validate(
    tx: Tx,
    scope: GuardianProducerScope,
    row: DeliverySourceApplication,
    producer: Awaited<ReturnType<typeof lockProducerMetadata>>,
  ) {
    this.assertProducer(row, producer);
    const manager = await this.manager(tx, scope),
      facts = await this.accepted(tx, scope, manager, row.publicationOperationId);
    requireCurrent(
      row.managerBindingId === manager.id &&
        row.cursorVersion === manager.cursorVersion &&
        row.nativeSequence === manager.nativeSequence &&
        storedRoot(row).physicalAnchorAttemptId === manager.activeAttemptId &&
        facts.target.id === row.targetRevisionId &&
        facts.target.taskId === row.taskId &&
        facts.target.stepId === row.stepId &&
        facts.target.producingAttemptId === row.producingAttemptId &&
        facts.target.headSha === row.targetHeadSha &&
        facts.target.inputSha === row.predecessorHeadSha &&
        facts.parentTurnId === storedRoot(row).native.parentTurnId,
    );
    return facts;
  }
  private async authority(
    tx: Tx,
    scope: GuardianProducerScope,
    row: DeliverySourceApplication,
    producer: Awaited<ReturnType<typeof lockProducerMetadata>>,
    target: Awaited<ReturnType<GuardianSourceApplicationStore["accepted"]>>["target"],
  ) {
    const time = await now(tx),
      runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({ where: { id: row.runtimeId } }),
      registration = await tx.codexHostRegistration.findUniqueOrThrow({
        where: { id: scope.registrationId },
      });
    const expiresAt = Math.floor(
      Math.min(
        time.getTime() + 30000,
        runtime.authorityUntil.getTime(),
        registration.expiresAt.getTime(),
      ) / 1000,
    );
    requireCurrent(expiresAt * 1000 > time.getTime());
    const previous = row.previousAppliedRevisionId
      ? await tx.deliverySourceRevision.findUniqueOrThrow({
          where: { id: row.previousAppliedRevisionId },
        })
      : null;
    const {
      metadataPins,
      metadataPinsDigest,
      metadataPolicyDigest,
      namespaceReceiptDigest,
      ...admission
    } = producer;
    return guardianApplicationAuthoritySchema.parse({
      schemaVersion: 1 as const,
      applicationId: row.id,
      phase: row.phase,
      operationId: row.publicationOperationId,
      sourceContext: context(target),
      previousSourceContext: previous ? context(previous) : null,
      parentSha: target.inputSha,
      treeSha: target.treeSha,
      manifestDigest: target.manifestDigest,
      metadataIdentity: metadataPins,
      producer: { ...admission, metadataPinsDigest, metadataPolicyDigest, namespaceReceiptDigest },
      inputBarrier: {
        id: row.inputBarrierId,
        digest: row.inputBarrierDigest,
        generation: (row.inputBarrier as { generation: number }).generation,
      },
      expiresAt,
      applicationAuthorized: true as const,
      executionAuthorized: false as const,
      cleanupAuthorized: false as const,
    });
  }
  reserve(scope: GuardianProducerScope, value: unknown) {
    const input = guardianApplicationReservationSchema.parse(value);
    requireCurrent(input.projectId === scope.projectId);
    return this.transaction(scope, async (tx, verified, producer) => {
      const existing = await tx.deliverySourceApplication.findUnique({
        where: { id: input.applicationId },
      });
      if (existing) {
        const row = await this.row(tx, verified, input.applicationId);
        requireCurrent(row.requestDigest === guardianDigest(input));
        const facts = await this.validate(tx, verified, row, producer);
        return this.authority(tx, verified, row, producer, facts.target);
      }
      const manager = await this.manager(tx, verified),
        facts = await this.accepted(tx, verified, manager, input.publicationOperationId),
        time = await now(tx),
        snapshot = input.idleSnapshot,
        barrier = input.inputBarrier;
      requireCurrent(
        same(input.targetSourceContext, context(facts.target)) &&
          snapshot.projectId === verified.projectId &&
          snapshot.admissionId === producer.admissionId &&
          snapshot.admissionGeneration === producer.admissionGeneration &&
          snapshot.managerBindingId === manager.id &&
          snapshot.currentAttemptId === facts.attempt.id &&
          snapshot.managerThreadId === verified.managerThreadId &&
          snapshot.parentTurnId === facts.parentTurnId &&
          snapshot.cursorVersion === manager.cursorVersion &&
          snapshot.nativeSequence === manager.nativeSequence &&
          barrier.projectId === verified.projectId &&
          [snapshot.observedAt, barrier.observedAt].every(
            (v) => Date.parse(v) <= time.getTime() && time.getTime() - Date.parse(v) <= 5000,
          ),
      );
      const previous = await tx.deliverySourceApplication.findFirst({
        where: { ownerId: verified.hiveUserId, admissionId: producer.admissionId },
        orderBy: { applicationVersion: "desc" },
      });
      if (previous && previous.phase !== "applied")
        throw new DeliveryConflict("source_application_pending");
      const previousRevision = previous
        ? await tx.deliverySourceRevision.findUniqueOrThrow({
            where: { id: previous.targetRevisionId },
          })
        : null;
      requireCurrent(
        same(
          input.expectedAppliedSourceContext,
          previousRevision ? context(previousRevision) : null,
        ) &&
          facts.target.previousRevisionId === (previousRevision?.id ?? null) &&
          facts.target.inputSha === (previousRevision?.headSha ?? manager.sourceSha) &&
          facts.target.version === (previousRevision?.version ?? 0) + 1,
      );
      const row = await tx.deliverySourceApplication.create({
        data: {
          id: input.applicationId,
          ownerId: verified.hiveUserId,
          runtimeId: producer.runtimeId,
          runtimeGeneration: producer.runtimeGeneration,
          admissionId: producer.admissionId,
          admissionGeneration: producer.admissionGeneration,
          producerDigest: producer.producerDigest,
          registrationId: verified.registrationId,
          serverInstanceId: verified.serverInstanceId,
          managerThreadId: verified.managerThreadId,
          managerBindingId: manager.id,
          taskId: facts.target.taskId,
          stepId: facts.target.stepId,
          producingAttemptId: facts.attempt.id,
          publicationOperationId: input.publicationOperationId,
          targetRevisionId: facts.target.id,
          previousAppliedRevisionId: previousRevision?.id,
          previousApplicationId: previous?.id,
          applicationVersion: (previous?.applicationVersion ?? 0) + 1,
          predecessorHeadSha: facts.target.inputSha,
          targetHeadSha: facts.target.headSha,
          metadataPinsDigest: producer.metadataPinsDigest,
          namespaceReceiptDigest: producer.namespaceReceiptDigest,
          cursorVersion: manager.cursorVersion,
          nativeSequence: manager.nativeSequence,
          idleSnapshotDigest: guardianDigest(snapshot),
          idleSnapshot: { native: snapshot, physicalAnchorAttemptId: manager.activeAttemptId },
          inputBarrierId: barrier.id,
          inputBarrierDigest: guardianDigest(barrier),
          inputBarrier: barrier,
          requestDigest: guardianDigest(input),
        },
      });
      return this.authority(tx, verified, row, producer, facts.target);
    });
  }
  verify(scope: GuardianProducerScope, applicationId: string) {
    return this.transaction(scope, async (tx, verified, producer) => {
      const row = await this.row(tx, verified, applicationId),
        facts = await this.validate(tx, verified, row, producer);
      return this.authority(tx, verified, row, producer, facts.target);
    });
  }
  commit(scope: GuardianProducerScope, applicationId: string, value: unknown) {
    const receipt: GuardianApplicationReceipt = guardianApplicationReceiptSchema.parse(value);
    return this.transaction(scope, async (tx, verified, producer) => {
      const row = await this.row(tx, verified, applicationId),
        facts = await this.validate(tx, verified, row, producer),
        time = await now(tx);
      const previous = row.previousAppliedRevisionId
        ? await tx.deliverySourceRevision.findUniqueOrThrow({
            where: { id: row.previousAppliedRevisionId },
          })
        : null;
      requireCurrent(
        receipt.applicationId === row.id &&
          receipt.publicationOperationId === row.publicationOperationId &&
          same(receipt.sourceContext, context(facts.target)) &&
          same(receipt.previousSourceContext, previous ? context(previous) : null) &&
          same(receipt.controllerSourceContext, receipt.sourceContext) &&
          same(receipt.supervisorSourceContext, receipt.sourceContext) &&
          receipt.inputBarrierId === row.inputBarrierId &&
          receipt.inputBarrierDigest === row.inputBarrierDigest &&
          receipt.metadataPinsDigest === row.metadataPinsDigest &&
          receipt.namespaceReceiptDigest === row.namespaceReceiptDigest &&
          receipt.appliedHeadSha === row.targetHeadSha &&
          Date.parse(receipt.observedAt) <= time.getTime() &&
          time.getTime() - Date.parse(receipt.observedAt) <= 5000,
      );
      const receiptDigest = guardianDigest(receipt);
      if (row.phase === "applied") requireCurrent(row.appliedReceiptDigest === receiptDigest);
      else
        await tx.deliverySourceApplication.update({
          where: { id: row.id },
          data: {
            phase: "applied",
            appliedAt: time,
            appliedReceiptDigest: receiptDigest,
            appliedEvidence: receipt,
          },
        });
      const updated = await tx.deliverySourceApplication.findUniqueOrThrow({
        where: { id: row.id },
      });
      return this.authority(tx, verified, updated, producer, facts.target);
    });
  }
}
