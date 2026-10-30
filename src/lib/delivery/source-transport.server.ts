import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import {
  lockActiveRegistration,
  RegistrationRejected,
} from "@/lib/codex-session/registration-store.server";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import {
  type ImmutableGitHubArtifactStore,
  isGitHubSerializationConflict,
} from "./github-persistence.server";
import type { ManagerDependencies } from "./manager.server";
import {
  authenticateCheckoutHost,
  lockManagerCheckout,
  stableDeliveryUuid,
} from "./manager-binding.server";
import { NATIVE_OBSERVER_PRODUCER } from "./native-contracts";
import { DeliverySourcePublicationService } from "./source-publication.server";
import { resolveTaskSource } from "./source-resolver.server";
import {
  type SourceChallengeRequest,
  type SourcePolicyRequest,
  type SourceProducerScope,
  type SourcePublicationGrant,
  type SourcePublishEnvelope,
  sourceChallengeRequestSchema,
  sourcePolicyRequestSchema,
  sourceProducerAdmissionSchema,
  sourcePublicationGrantSchema,
  sourcePublicationPolicySchema,
  sourcePublishEnvelopeSchema,
  sourceTransportProofPayload,
} from "./source-transport-contracts";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
type Authenticated = { ownerId: string; hostPublicKeyPem: string };
export const SOURCE_PROOF_MAX_BYTES = 96 * 1024;
const group = (bindingId: string, operationId: string) =>
  `source-publication-grants/${bindingId}/${operationId}`;
const consumeId = (id: string) => stableDeliveryUuid(`source-publication-consumed/${id}`);
const reservationId = (id: string) => stableDeliveryUuid(`source-publication-proof/${id}`);
const revokeId = (id: string) => stableDeliveryUuid(`source-publication-revoked/${id}`);
export interface SourceTransportDependencies extends Pick<ManagerDependencies, "reauthorize"> {
  /** Server-owned persisted guardian store. Must own slot/registration then
   * runtime/admission locks, require finalized OPEN source-producing admission,
   * derive Coder owner from User+slot and check closed-barrier/generation. */
  lockProducerAdmission(tx: Tx, scope: SourceProducerScope): Promise<unknown>;
  /** Private controller configuration. No repository or model policy input. */
  resolvePolicy(scope: {
    ownerId: string;
    taskId: string;
    repositoryId: string;
  }): Promise<unknown> | unknown;
}

/** Only this transport's exact event-ID races may retry. Worker and Node
 * Prisma constructors differ, so use the observed structured error metadata. */
function eventReplayCollision(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    name?: unknown;
    code?: unknown;
    clientVersion?: unknown;
    meta?: Record<string, unknown>;
  };
  if (
    e.name !== "PrismaClientKnownRequestError" ||
    e.code !== "P2002" ||
    typeof e.clientVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(e.clientVersion) ||
    e.meta?.modelName !== "DeliveryEvent"
  )
    return false;
  let target = e.meta.target;
  if (target === undefined) {
    const adapter = e.meta.driverAdapterError as
      | { name?: unknown; cause?: { kind?: unknown; constraint?: { fields?: unknown } } }
      | undefined;
    if (
      adapter?.name !== "DriverAdapterError" ||
      adapter.cause?.kind !== "UniqueConstraintViolation"
    )
      return false;
    target = adapter.cause.constraint?.fields;
  }
  return (
    Array.isArray(target) &&
    ["id", "owner_id,id", "ownerId,id"].includes(target.join(",")) &&
    target.every((v) => typeof v === "string")
  );
}

/** Registered host signatures alone are insufficient: every path additionally
 * calls the independently persisted guardian authority supplied by composition. */
export class SourcePublicationTransport {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: SourceTransportDependencies,
    private readonly artifacts: ImmutableGitHubArtifactStore,
  ) {}
  private async transaction<T>(fn: (tx: Tx) => Promise<T>) {
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 10000,
        });
      } catch (error) {
        if (retry >= 2 || !(isGitHubSerializationConflict(error) || eventReplayCollision(error)))
          throw error;
      }
  }
  private async producer(
    tx: Tx,
    input: SourcePolicyRequest | SourceChallengeRequest | SourcePublishEnvelope,
    authenticated: Authenticated,
  ) {
    const active = await lockActiveRegistration(tx, {
      ownerId: authenticated.ownerId,
      registrationId: input.registrationId,
    });
    if (
      active.registration.hostPublicKeyPem !== authenticated.hostPublicKeyPem ||
      active.registration.serverInstanceId !== input.serverInstanceId ||
      !active.registration.threads.some(
        (t) =>
          t.projectId === input.checkoutBinding.projectId &&
          t.nativeThreadId === input.managerThreadId,
      )
    )
      throw new RegistrationRejected();
    const admission = sourceProducerAdmissionSchema.parse(
      await this.dependencies.lockProducerAdmission(tx, {
        hiveUserId: authenticated.ownerId,
        registrationId: input.registrationId,
        workspaceId: active.slot.workspaceId,
        buildId: active.registration.buildId,
        serverInstanceId: input.serverInstanceId,
        managerThreadId: input.managerThreadId,
        projectId: input.checkoutBinding.projectId,
        preparationIntentId: input.checkoutBinding.preparationIntentId,
        repositoryId: input.checkoutBinding.repositoryId,
        leaseId: input.checkoutBinding.leaseId,
        leaseGeneration: input.checkoutBinding.leaseGeneration,
      }),
    );
    return admission;
  }
  private async scope(
    tx: Tx,
    input: SourcePolicyRequest | SourceChallengeRequest | SourcePublishEnvelope,
    authenticated: Authenticated,
  ) {
    const admission = await this.producer(tx, input, authenticated);
    const host = await lockManagerCheckout(tx, input, authenticated, { allowBlocked: true });
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_tasks WHERE owner_id=${authenticated.ownerId}::uuid AND id=${input.taskId}::uuid FOR UPDATE`;
    if (rows.length !== 1) throw new RegistrationRejected();
    const task = await tx.deliveryTask.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: authenticated.ownerId, id: input.taskId } },
      include: { project: true },
    });
    const attempt = await tx.deliveryAttempt.findUnique({
      where: { ownerId_id: { ownerId: authenticated.ownerId, id: input.attemptId } },
      include: { step: true },
    });
    if (
      !attempt ||
      task.managerBindingId !== host.binding.id ||
      task.projectId !== host.binding.projectId ||
      task.conversationId !== host.binding.conversationId ||
      attempt.managerBindingId !== host.binding.id ||
      attempt.stepId !== input.stepId ||
      attempt.step.taskId !== task.id ||
      task.project.provider !== "github"
    )
      throw new RegistrationRejected();
    const policy = sourcePublicationPolicySchema.parse(
      await this.dependencies.resolvePolicy({
        ownerId: authenticated.ownerId,
        taskId: task.id,
        repositoryId: task.project.providerRepositoryId,
      }),
    );
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    if (input.expiresAt <= now.getTime() || host.registration.expiresAt <= now)
      throw new RegistrationRejected();
    return {
      ...host,
      task,
      attempt,
      admission,
      policy,
      policyDigest: githubSourceDigest(policy),
      now,
    };
  }
  private async runnable(
    tx: Tx,
    input: SourcePolicyRequest | SourceChallengeRequest | SourcePublishEnvelope,
    scope: Awaited<ReturnType<SourcePublicationTransport["scope"]>>,
  ) {
    const source = await resolveTaskSource(
      tx,
      scope.task.ownerId,
      scope.task.id,
      input.sourceContext,
      true,
    );
    const { attempt, binding, task, now } = scope;
    if (
      binding.progressionProtocol !== 1 ||
      binding.currentAttemptId !== attempt.id ||
      binding.blockedReason ||
      task.pauseRequested ||
      task.schedulingPaused ||
      attempt.outcome !== "running" ||
      attempt.step.state !== "running" ||
      attempt.step.kind !== "implement" ||
      attempt.step.acceptancePhase === "activation_production" ||
      attempt.outputRevisionId ||
      attempt.leaseExpiresAt <= now ||
      attempt.leaseGeneration !== attempt.step.leaseGeneration ||
      attempt.sourceSha !== source.headSha
    )
      throw new DeliveryConflict("source_producer_not_ready");
    const native = await tx.deliveryEvent.findFirst({
      where: {
        ownerId: task.ownerId,
        attemptId: attempt.id,
        type: {
          in: [
            "native_attempt_observed",
            "native_source_conflict",
            "native_command_observed",
            "native_runtime_started",
          ],
        },
      },
      orderBy: { aggregateVersion: "desc" },
    });
    const proof = native?.payload as {
      producer?: unknown;
      nativeSourceKind?: unknown;
      turnStatus?: unknown;
    } | null;
    if (
      !attempt.runtimeBindingDigest ||
      proof?.producer !== NATIVE_OBSERVER_PRODUCER ||
      proof.nativeSourceKind !== "turn_completed" ||
      proof.turnStatus !== "completed" ||
      !attempt.effectiveModel ||
      attempt.effectiveModel !== attempt.requestedModel ||
      !attempt.effectiveEffort ||
      attempt.effectiveEffort !== attempt.requestedEffort
    )
      throw new DeliveryConflict("source_native_execution_unverified");
    return source;
  }
  async policy(value: unknown) {
    value = JSON.parse(canonicalGitHubSource(value));
    const input = sourcePolicyRequestSchema.parse(value);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      sourceTransportProofPayload("policy", value as Record<string, unknown>),
    );
    return this.transaction(async (tx) => {
      const scope = await this.scope(tx, input, authenticated),
        source = await this.runnable(tx, input, scope);
      return {
        operationId: input.operationId,
        parentSha: source.headSha,
        ...(source.context ? { sourceContext: source.context } : {}),
        sourceVersion: scope.task.sourceVersion,
        repositoryId: scope.task.project.providerRepositoryId,
        providerAccountId: scope.task.project.providerAccountId,
        fullName: scope.task.project.fullName,
        branch: `codex/delivery/${input.taskId}/${input.operationId}`,
        policy: scope.policy,
        policyDigest: scope.policyDigest,
        expiresAt: Math.min(
          scope.now.getTime() + 60000,
          scope.registration.expiresAt.getTime(),
          scope.attempt.leaseExpiresAt.getTime(),
        ),
      };
    });
  }
  async issue(value: unknown) {
    value = JSON.parse(canonicalGitHubSource(value));
    const input = sourceChallengeRequestSchema.parse(value);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      sourceTransportProofPayload("challenge", value as Record<string, unknown>),
    );
    return this.transaction(async (tx) => {
      const scope = await this.scope(tx, input, authenticated),
        source = await this.runnable(tx, input, scope);
      if (input.policyDigest !== scope.policyDigest)
        throw new DeliveryConflict("source_policy_changed");
      this.validateManifest(input.manifest, scope.policy, input.target.manifestDigest);
      if (input.target.headSha === source.headSha) throw new DeliveryConflict("source_unchanged");
      if (
        await tx.deliverySourceRevision.findUnique({
          where: {
            ownerId_managerBindingId_operationId: {
              ownerId: authenticated.ownerId,
              managerBindingId: scope.binding.id,
              operationId: input.operationId,
            },
          },
        })
      )
        throw new DeliveryConflict("source_operation_already_recorded");
      const operationScope = {
        registrationId: input.registrationId,
        managerBindingId: scope.binding.id,
        checkoutBindingDigest: scope.binding.bindingDigest,
        ownerId: authenticated.ownerId,
        taskId: input.taskId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        operationId: input.operationId,
        ...(source.context ? { sourceContext: source.context } : {}),
        sourceVersion: scope.task.sourceVersion,
        parentSha: source.headSha,
        cursorVersion: scope.binding.cursorVersion,
        nativeSequence: scope.binding.nativeSequence,
        leaseGeneration: scope.attempt.leaseGeneration,
        repositoryId: scope.task.project.providerRepositoryId,
        providerAccountId: scope.task.project.providerAccountId,
        fullName: scope.task.project.fullName,
        branch: `codex/delivery/${input.taskId}/${input.operationId}`,
        target: input.target,
        policy: scope.policy,
        policyDigest: scope.policyDigest,
        admission: scope.admission,
      };
      const requestDigest = githubSourceDigest(operationScope),
        aggregateKey = group(scope.binding.id, input.operationId);
      const previous = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId: authenticated.ownerId, id: input.requestId } },
      });
      const latest = await tx.deliveryEvent.findFirst({
        where: { ownerId: authenticated.ownerId, taskId: input.taskId, aggregateKey },
        orderBy: { aggregateVersion: "desc" },
      });
      if (previous) {
        if (
          previous.type !== "source_publication_grant" ||
          previous.requestDigest !== requestDigest
        )
          throw new DeliveryConflict("source_grant_replay_conflict");
        const old = sourcePublicationGrantSchema.parse(previous.payload);
        if (latest?.id !== old.id || old.expiresAt <= scope.now.getTime())
          throw new DeliveryConflict("source_grant_expired_or_superseded");
        if (
          await tx.deliveryEvent.findUnique({
            where: { ownerId_id: { ownerId: authenticated.ownerId, id: revokeId(old.id) } },
          })
        )
          throw new RegistrationRejected();
        return old;
      }
      if (latest) {
        const old = sourcePublicationGrantSchema.parse(latest.payload);
        if (latest.requestDigest !== requestDigest)
          throw new DeliveryConflict("source_operation_scope_changed");
        if (old.expiresAt > scope.now.getTime())
          throw new DeliveryConflict("source_grant_already_active");
        if (latest.aggregateVersion >= 2)
          throw new DeliveryConflict("source_operation_grant_budget");
      }
      if (
        (await tx.deliveryEvent.count({
          where: {
            ownerId: authenticated.ownerId,
            taskId: input.taskId,
            type: "source_publication_grant",
          },
        })) >= 32
      )
        throw new DeliveryConflict("source_task_grant_budget");
      const grant = sourcePublicationGrantSchema.parse({
        schemaVersion: 1,
        action: "publish_source_revision",
        id: input.requestId,
        nonce: randomBytes(32).toString("hex"),
        expiresAt: Math.min(
          scope.now.getTime() + 60000,
          scope.registration.expiresAt.getTime(),
          scope.attempt.leaseExpiresAt.getTime(),
        ),
        ...operationScope,
      });
      if (grant.expiresAt <= scope.now.getTime()) throw new RegistrationRejected();
      await tx.deliveryEvent.create({
        data: {
          id: grant.id,
          ownerId: authenticated.ownerId,
          taskId: input.taskId,
          stepId: input.stepId,
          attemptId: input.attemptId,
          aggregateKey,
          aggregateVersion: (latest?.aggregateVersion ?? -1) + 1,
          type: "source_publication_grant",
          requestDigest,
          policyVersion: scope.policy.version,
          payload: grant,
        },
      });
      await tx.deliveryTask.update({ where: { id: input.taskId }, data: { updatedAt: scope.now } });
      return grant;
    });
  }
  private validateManifest(
    manifest: SourceChallengeRequest["manifest"],
    policy: SourcePublicationGrant["policy"],
    expectedDigest: string,
  ) {
    const files = manifest.files,
      deletions = manifest.deletions;
    const paths = [...files.map((v) => v.path), ...deletions];
    if (
      !paths.length ||
      paths.length > policy.maxFiles ||
      new Set(paths).size !== paths.length ||
      files.some((v) => v.size > policy.maxFileBytes) ||
      files.reduce((sum, v) => sum + v.size, 0) > policy.maxBytes ||
      canonicalGitHubSource(files.map((v) => v.path)) !==
        canonicalGitHubSource(files.map((v) => v.path).sort()) ||
      canonicalGitHubSource(deletions) !== canonicalGitHubSource([...deletions].sort()) ||
      githubSourceDigest(manifest) !== expectedDigest
    )
      throw new DeliveryConflict("source_manifest_invalid");
    for (const path of paths) {
      const parts = path.split("/");
      if (
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) ||
        parts.length > 16 ||
        !policy.allowedPrefixes.includes(parts[0]) ||
        parts.some(
          (v) =>
            v === "." ||
            v === ".." ||
            [".git", ".github", ".gitmodules", ".gitattributes"].includes(v.toLowerCase()) ||
            v.toLowerCase().startsWith(".env") ||
            /\.(pem|key)$/i.test(v),
        )
      )
        throw new DeliveryConflict("source_path_protected");
    }
  }
  private validateReadback(
    input: SourcePublishEnvelope,
    grant: SourcePublicationGrant,
    now: number,
  ) {
    const read = input.readback;
    this.validateManifest(read.manifest, grant.policy, grant.target.manifestDigest);
    if (
      Date.parse(read.observedAt) > now ||
      now - Date.parse(read.observedAt) > 10000 ||
      read.providerAccountId !== grant.providerAccountId ||
      read.repositoryId !== grant.repositoryId ||
      read.fullName.toLowerCase() !== grant.fullName.toLowerCase() ||
      read.commit.sha !== grant.target.headSha ||
      read.commit.treeSha !== grant.target.treeSha ||
      read.commit.parentSha !== grant.parentSha ||
      read.reference.name !== `refs/heads/${grant.branch}` ||
      read.reference.sha !== grant.target.headSha ||
      read.pullRequest.headRepositoryId !== grant.repositoryId ||
      read.pullRequest.baseRepositoryId !== grant.repositoryId ||
      read.pullRequest.headRef !== grant.branch ||
      read.pullRequest.headSha !== grant.target.headSha ||
      read.pullRequest.baseRef !== grant.policy.baseBranch
    )
      throw new DeliveryConflict("source_readback_scope_mismatch");
  }
  async publish(value: unknown) {
    value = JSON.parse(canonicalGitHubSource(value));
    const input = sourcePublishEnvelopeSchema.parse(value);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      sourceTransportProofPayload("publish", value as Record<string, unknown>),
    );
    const event = await this.db.deliveryEvent.findUnique({
      where: { ownerId_id: { ownerId: authenticated.ownerId, id: input.challengeId } },
    });
    if (
      !event ||
      event.type !== "source_publication_grant" ||
      event.taskId !== input.taskId ||
      event.stepId !== input.stepId ||
      event.attemptId !== input.attemptId
    )
      throw new RegistrationRejected();
    const grant = sourcePublicationGrantSchema.parse(event.payload),
      wireDigest = githubSourceDigest(value);
    const object = {
        schemaVersion: 1,
        source: "github-source-publication",
        grant,
        envelope: value,
      },
      bytes = Buffer.from(canonicalGitHubSource(object)),
      proofDigest = githubSourceDigest(object);
    if (bytes.length > SOURCE_PROOF_MAX_BYTES) throw new DeliveryConflict("source_proof_too_large");
    const objectKey = `delivery/${authenticated.ownerId}/github/${grant.repositoryId}/${grant.target.headSha}/${proofDigest}.json`;
    const authorize = async (tx: Tx, consume: boolean) => {
      const scope = await this.scope(tx, input, authenticated);
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_events WHERE owner_id=${authenticated.ownerId}::uuid AND id=${grant.id}::uuid FOR UPDATE`;
      const latest = await tx.deliveryEvent.findFirst({
        where: {
          ownerId: authenticated.ownerId,
          taskId: input.taskId,
          aggregateKey: group(scope.binding.id, grant.operationId),
        },
        orderBy: { aggregateVersion: "desc" },
      });
      if (
        rows.length !== 1 ||
        latest?.id !== grant.id ||
        grant.registrationId !== input.registrationId ||
        grant.nonce !== input.nonce ||
        grant.expiresAt <= scope.now.getTime() ||
        grant.managerBindingId !== scope.binding.id ||
        grant.checkoutBindingDigest !== scope.binding.bindingDigest ||
        grant.policyDigest !== scope.policyDigest ||
        canonicalGitHubSource(grant.admission) !== canonicalGitHubSource(scope.admission) ||
        canonicalGitHubSource(input.sourceContext) !== canonicalGitHubSource(grant.sourceContext)
      )
        throw new RegistrationRejected();
      if (
        await tx.deliveryEvent.findUnique({
          where: { ownerId_id: { ownerId: authenticated.ownerId, id: revokeId(grant.id) } },
        })
      )
        throw new RegistrationRejected();
      const consumed = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId: authenticated.ownerId, id: consumeId(grant.id) } },
      });
      if (consumed) {
        if (
          consumed.type !== "source_publication_consumed" ||
          consumed.requestDigest !== wireDigest
        )
          throw new DeliveryConflict("source_grant_already_consumed");
        return;
      }
      this.validateReadback(input, grant, scope.now.getTime());
      const reserved = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId: authenticated.ownerId, id: reservationId(grant.id) } },
      });
      if (
        reserved &&
        (reserved.type !== "source_publication_proof_reserved" ||
          reserved.requestDigest !== wireDigest)
      )
        throw new DeliveryConflict("source_proof_replay_conflict");
      if (consume && !reserved) throw new DeliveryConflict("source_proof_not_reserved");
      const source = await this.runnable(tx, input, scope);
      if (
        source.headSha !== grant.parentSha ||
        scope.task.sourceVersion !== grant.sourceVersion ||
        scope.binding.cursorVersion !== grant.cursorVersion ||
        scope.binding.nativeSequence !== grant.nativeSequence ||
        scope.attempt.leaseGeneration !== grant.leaseGeneration
      )
        throw new DeliveryConflict("source_grant_scope_changed");
      if (!consume && !reserved)
        await tx.deliveryEvent.create({
          data: {
            id: reservationId(grant.id),
            ownerId: authenticated.ownerId,
            taskId: input.taskId,
            stepId: input.stepId,
            attemptId: input.attemptId,
            aggregateKey: `source-publication-proof/${grant.id}`,
            aggregateVersion: 0,
            type: "source_publication_proof_reserved",
            requestDigest: wireDigest,
            policyVersion: grant.policy.version,
            payload: {
              challengeId: grant.id,
              operationId: grant.operationId,
              proofDigest,
              objectKey,
              size: bytes.length,
              verified: false,
            },
          },
        });
      if (consume)
        await tx.deliveryEvent.create({
          data: {
            id: consumeId(grant.id),
            ownerId: authenticated.ownerId,
            taskId: input.taskId,
            stepId: input.stepId,
            attemptId: input.attemptId,
            aggregateKey: `source-publication-receipt/${grant.id}`,
            aggregateVersion: 0,
            type: "source_publication_consumed",
            requestDigest: wireDigest,
            policyVersion: grant.policy.version,
            payload: {
              challengeId: grant.id,
              operationId: grant.operationId,
              proofDigest,
              objectKey,
              size: bytes.length,
            },
          },
        });
    };
    await this.transaction((tx) => authorize(tx, false));
    const archived = await this.artifacts.writeAndVerify(objectKey, bytes, proofDigest);
    if (archived.contentDigest !== proofDigest || archived.size !== bytes.length)
      throw new DeliveryConflict("source_proof_unverified");
    const publication = {
      schemaVersion: 1,
      operationId: grant.operationId,
      ownerId: authenticated.ownerId,
      taskId: input.taskId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      registrationId: input.registrationId,
      serverInstanceId: input.serverInstanceId,
      managerThreadId: input.managerThreadId,
      checkoutBinding: input.checkoutBinding,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
      expectedSourceVersion: grant.sourceVersion,
      expectedRevisionId: grant.sourceContext?.revisionId ?? null,
      expectedCursorVersion: grant.cursorVersion,
      expectedNativeSequence: grant.nativeSequence,
      leaseGeneration: grant.leaseGeneration,
      parentSha: grant.parentSha,
      headSha: grant.target.headSha,
      treeSha: grant.target.treeSha,
      manifestDigest: grant.target.manifestDigest,
      repositoryId: grant.repositoryId,
      providerAccountId: grant.providerAccountId,
      fullName: grant.fullName,
      branch: grant.branch,
      baseBranch: grant.policy.baseBranch,
      pullRequestId: input.readback.pullRequest.id,
      pullNumber: input.readback.pullRequest.number,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
    return new DeliverySourcePublicationService(this.db, {
      reauthorize: this.dependencies.reauthorize,
      authority: {
        verify: async () => ({ publication, proofDigest }),
        lockTransaction: async (tx) => {
          const current = await this.producer(tx, input, authenticated);
          if (canonicalGitHubSource(current) !== canonicalGitHubSource(grant.admission))
            throw new RegistrationRejected();
        },
        authorizeTransaction: (tx) => authorize(tx, true),
      },
    }).accept(value);
  }
  /** Internal controller operation only; no browser/manager revocation route.
   * It can revoke after a guardian closes and never acquires locks in reverse. */
  async revoke(ownerId: string, challengeId: string, reason: string) {
    z.string().uuid().parse(ownerId);
    z.string().uuid().parse(challengeId);
    z.string().min(1).max(500).parse(reason);
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_events WHERE owner_id=${ownerId}::uuid AND id=${challengeId}::uuid FOR UPDATE`;
      const event = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId, id: challengeId } },
      });
      if (rows.length !== 1 || event?.type !== "source_publication_grant")
        throw new RegistrationRejected();
      const grant = sourcePublicationGrantSchema.parse(event.payload),
        id = revokeId(grant.id);
      const old = await tx.deliveryEvent.findUnique({ where: { ownerId_id: { ownerId, id } } });
      if (old) return { revoked: true, replayed: true };
      await tx.deliveryEvent.create({
        data: {
          id,
          ownerId,
          taskId: event.taskId,
          stepId: event.stepId,
          attemptId: event.attemptId,
          aggregateKey: `source-publication-revocation/${grant.id}`,
          aggregateVersion: 0,
          type: "source_publication_revoked",
          requestDigest: githubSourceDigest({ challengeId, reason }),
          policyVersion: grant.policy.version,
          payload: { challengeId, reason },
        },
      });
      return { revoked: true, replayed: false };
    });
  }
}
