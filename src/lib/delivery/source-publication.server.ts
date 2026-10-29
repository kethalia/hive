import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { sourceContextSchema, sourceShaSchema } from "./contracts";
import { githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import { lockManagerCheckout, stableDeliveryUuid } from "./manager-binding.server";
import { managerCheckoutSchema } from "./manager-contracts";
import { NATIVE_OBSERVER_PRODUCER } from "./native-contracts";
import { resolveTaskSource } from "./source-resolver.server";
import { DeliveryConflict } from "./state";

const id = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const sourcePublicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: id,
    ownerId: id,
    taskId: id,
    stepId: id,
    attemptId: id,
    registrationId: id,
    serverInstanceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
    managerThreadId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
    checkoutBinding: managerCheckoutSchema,
    sourceContext: sourceContextSchema.optional(),
    expectedSourceVersion: z.number().int().nonnegative(),
    expectedRevisionId: id.nullable(),
    expectedCursorVersion: z.number().int().positive(),
    expectedNativeSequence: z.number().int().positive(),
    leaseGeneration: z.number().int().positive(),
    parentSha: sourceShaSchema,
    headSha: sourceShaSchema,
    treeSha: sourceShaSchema,
    manifestDigest: digest,
    repositoryId: providerId,
    providerAccountId: providerId,
    fullName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
    branch: z.string().min(1).max(255),
    baseBranch: z.string().min(1).max(255),
    pullRequestId: providerId,
    pullNumber: z.number().int().positive().max(2147483647),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type SourcePublication = z.infer<typeof sourcePublicationSchema>;
export const SOURCE_PUBLICATION_PRODUCER = "protected-source-broker-v1";

export interface SourcePublicationAuthority {
  /** Separate installed producer authority, not a JSON boolean. Must authenticate
   * the entire receipt, provider readbacks and exact scope; no default exists. */
  verify(receipt: unknown): Promise<{ publication: unknown; proofDigest: string }>;
  /** Recheck persisted producer revocation/scope inside the mutation transaction.
   * Host owner/build/lease and source CAS are also independently checked below. */
  authorizeTransaction(
    tx: Prisma.TransactionClient,
    scope: {
      publication: SourcePublication;
      proofDigest: string;
      bindingDigest: string;
    },
  ): Promise<void>;
}

/** Internal capability only. No route/factory wires this producer to a manager,
 * browser, fixture broker, scheduled job or live provider in this slice. */
export class DeliverySourcePublicationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: {
      reauthorize(binding: RegistrationBinding): Promise<RegistrationBinding>;
      authority?: SourcePublicationAuthority;
    },
  ) {}
  async accept(receipt: unknown) {
    const authority = this.dependencies.authority;
    if (
      !authority ||
      (receipt &&
        typeof receipt === "object" &&
        ("fixtureOnly" in receipt || "freshAcceptanceAuthority" in receipt))
    )
      throw new DeliveryConflict("source_publication_unactivated");
    const verified = await authority.verify(receipt),
      input = sourcePublicationSchema.parse(verified.publication);
    if (input.expiresAt <= input.issuedAt || input.expiresAt - input.issuedAt > 60_000)
      throw new RegistrationRejected();
    const proofDigest = digest.parse(verified.proofDigest);
    const { issuedAt: _issued, expiresAt: _expires, ...semantic } = input;
    const requestDigest = githubSourceDigest({
      producer: SOURCE_PUBLICATION_PRODUCER,
      publication: semantic,
    });
    const registration = await this.db.codexHostRegistration.findUnique({
      where: { id: input.registrationId },
    });
    if (!registration || registration.ownerId !== input.ownerId) throw new RegistrationRejected();
    await this.dependencies.reauthorize(registration.binding as unknown as RegistrationBinding);
    for (let retry = 0; ; retry++) {
      try {
        const result = await this.db.$transaction(
          async (tx) => {
            const scope = await lockManagerCheckout(tx, input, registration, {
              allowBlocked: true,
            });
            const found = await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM delivery_tasks WHERE owner_id=${input.ownerId}::uuid AND id=${input.taskId}::uuid FOR UPDATE`;
            if (found.length !== 1) throw new DeliveryConflict("task_not_found");
            const task = await tx.deliveryTask.findUniqueOrThrow({
              where: { ownerId_id: { ownerId: input.ownerId, id: input.taskId } },
              include: { project: true },
            });
            await authority.authorizeTransaction(tx, {
              publication: input,
              proofDigest,
              bindingDigest: scope.binding.bindingDigest,
            });
            await lockManagerCheckout(tx, input, registration, { allowBlocked: true });
            const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]
              .now;
            if (scope.registration.expiresAt <= now || input.expiresAt <= now.getTime())
              throw new RegistrationRejected();
            const prior = await tx.deliverySourceRevision.findUnique({
              where: {
                ownerId_managerBindingId_operationId: {
                  ownerId: input.ownerId,
                  managerBindingId: scope.binding.id,
                  operationId: input.operationId,
                },
              },
            });
            if (prior) {
              if (prior.requestDigest !== requestDigest)
                throw new DeliveryConflict("source_publication_replay_conflict");
              return {
                sourceContext: {
                  revisionId: prior.id,
                  version: prior.version,
                  headSha: prior.headSha,
                },
                inputSourceSha: prior.inputSha,
                replayed: true,
                current: task.sourceRevisionId === prior.id,
                executionAuthorized: false,
              };
            }
            const holdEventId = stableDeliveryUuid(
              `source-publication-hold/${scope.binding.id}/${input.operationId}`,
            );
            const priorHold = await tx.deliveryEvent.findUnique({
              where: { ownerId_id: { ownerId: input.ownerId, id: holdEventId } },
            });
            if (priorHold) {
              if (
                priorHold.type !== "source_publication_held" ||
                priorHold.requestDigest !== requestDigest
              )
                throw new DeliveryConflict("source_publication_replay_conflict");
              return {
                blockedReason: "source_publication_external_effects_require_reconciliation",
              };
            }
            const source = await resolveTaskSource(
              tx,
              input.ownerId,
              task.id,
              input.sourceContext,
              true,
            );
            const attempt = await tx.deliveryAttempt.findUnique({
              where: { ownerId_id: { ownerId: input.ownerId, id: input.attemptId } },
              include: { step: true },
            });
            if (
              input.expiresAt <= input.issuedAt ||
              input.expiresAt - input.issuedAt > 60_000 ||
              input.issuedAt > now.getTime() ||
              input.expiresAt <= now.getTime()
            )
              throw new RegistrationRejected();
            if (
              !attempt ||
              task.managerBindingId !== scope.binding.id ||
              task.projectId !== scope.binding.projectId ||
              task.conversationId !== scope.binding.conversationId ||
              scope.binding.progressionProtocol !== 1 ||
              scope.binding.currentAttemptId !== attempt.id ||
              scope.binding.cursorVersion !== input.expectedCursorVersion ||
              scope.binding.nativeSequence !== input.expectedNativeSequence ||
              scope.binding.blockedReason ||
              task.pauseRequested ||
              task.schedulingPaused ||
              attempt.managerBindingId !== scope.binding.id ||
              attempt.stepId !== input.stepId ||
              attempt.step.taskId !== task.id ||
              attempt.step.kind !== "implement" ||
              attempt.step.acceptancePhase === "activation_production" ||
              attempt.outcome !== "running" ||
              attempt.step.state !== "running" ||
              attempt.outputRevisionId ||
              attempt.leaseGeneration !== input.leaseGeneration ||
              attempt.step.leaseGeneration !== input.leaseGeneration ||
              attempt.leaseExpiresAt <= now ||
              task.sourceVersion !== input.expectedSourceVersion ||
              task.sourceRevisionId !== input.expectedRevisionId ||
              source.headSha !== input.parentSha ||
              attempt.sourceSha !== input.parentSha ||
              input.headSha === input.parentSha ||
              task.project.provider !== "github" ||
              task.project.providerRepositoryId !== input.repositoryId ||
              task.project.providerAccountId !== input.providerAccountId ||
              task.project.fullName.toLowerCase() !== input.fullName.toLowerCase() ||
              input.branch !== `codex/delivery/${task.id}/${input.operationId}`
            )
              throw new DeliveryConflict("source_publication_scope_changed");
            const native = await tx.deliveryEvent.findFirst({
              where: {
                ownerId: input.ownerId,
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
            const observation = native?.payload as {
              producer?: unknown;
              nativeSourceKind?: unknown;
              turnStatus?: unknown;
            } | null;
            if (
              !attempt.runtimeBindingDigest ||
              observation?.producer !== NATIVE_OBSERVER_PRODUCER ||
              observation.nativeSourceKind !== "turn_completed" ||
              observation.turnStatus !== "completed" ||
              !attempt.effectiveModel ||
              attempt.effectiveModel !== attempt.requestedModel ||
              !attempt.effectiveEffort ||
              attempt.effectiveEffort !== attempt.requestedEffort
            )
              throw new DeliveryConflict("source_publication_execution_unverified");
            if (
              await tx.deliveryAttempt.findFirst({
                where: {
                  ownerId: input.ownerId,
                  step: { taskId: task.id },
                  outcome: "running",
                  id: { not: attempt.id },
                },
              })
            )
              throw new DeliveryConflict("source_publication_other_attempt_running");
            const completedSteps = await tx.deliveryStep.findMany({
              where: {
                ownerId: input.ownerId,
                taskId: task.id,
                id: { not: attempt.stepId },
                state: "succeeded",
              },
            });
            const effects = completedSteps.filter(
              (step) =>
                ["migrate", "backfill", "release", "observe"].includes(step.kind) ||
                step.requiredEvidenceKinds.includes("migration") ||
                (["review", "validate"].includes(step.kind) &&
                  step.requiredEvidenceKinds.includes("change")),
            );
            if (effects.length) {
              const reason =
                "Source publication requires reconciliation of completed external actions; they will not be rerun automatically.";
              await lockManagerCheckout(tx, input, registration);
              const eventId = holdEventId;
              await tx.deliveryTask.update({
                where: { id: task.id },
                data: { pauseRequested: true, schedulingPaused: false, version: { increment: 1 } },
              });
              await tx.deliveryEvent.create({
                data: {
                  id: eventId,
                  ownerId: input.ownerId,
                  taskId: task.id,
                  aggregateKey: `task/${task.id}`,
                  aggregateVersion: task.version + 1,
                  type: "source_publication_held",
                  requestDigest,
                  policyVersion: "source-publication-v1",
                  payload: {
                    reason,
                    operationId: input.operationId,
                    publishedHeadSha: input.headSha,
                    stepIds: effects.map((step) => step.id),
                  },
                },
              });
              await tx.deliveryOutbox.create({ data: { ownerId: input.ownerId, eventId } });
              return {
                blockedReason: "source_publication_external_effects_require_reconciliation",
              };
            }
            const revision = await tx.deliverySourceRevision.create({
              data: {
                id: randomUUID(),
                ownerId: input.ownerId,
                taskId: task.id,
                managerBindingId: scope.binding.id,
                stepId: attempt.stepId,
                producingAttemptId: attempt.id,
                previousRevisionId: task.sourceRevisionId,
                version: task.sourceVersion + 1,
                inputSha: input.parentSha,
                headSha: input.headSha,
                treeSha: input.treeSha,
                manifestDigest: input.manifestDigest,
                operationId: input.operationId,
                requestDigest,
                producer: SOURCE_PUBLICATION_PRODUCER,
                proofDigest,
                repositoryId: input.repositoryId,
                providerAccountId: input.providerAccountId,
                fullName: input.fullName,
                branch: input.branch,
                baseBranch: input.baseBranch,
                pullRequestId: input.pullRequestId,
                pullNumber: input.pullNumber,
              },
            });
            await tx.deliveryAttempt.update({
              where: { id: attempt.id },
              data: { outputRevisionId: revision.id },
            });
            const invalidated = await tx.deliveryEvidence.updateMany({
              where: {
                ownerId: input.ownerId,
                step: { taskId: task.id },
                sourceSha: { not: input.headSha },
                invalidatedAt: null,
              },
              data: { invalidatedAt: now },
            });
            const previousSteps = completedSteps.filter((step) =>
              ["review", "validate"].includes(step.kind),
            );
            for (const step of previousSteps) {
              await tx.deliveryStep.update({
                where: { id: step.id },
                data: {
                  state: "pending",
                  version: { increment: 1 },
                  leaseGeneration: { increment: 1 },
                  reopenGeneration: { increment: 1 },
                  waitingReason: "Source advanced; independent evidence must be refreshed.",
                },
              });
              await tx.deliveryEvent.create({
                data: {
                  id: randomUUID(),
                  ownerId: input.ownerId,
                  taskId: task.id,
                  stepId: step.id,
                  aggregateKey: `step/${step.id}`,
                  aggregateVersion: step.version + 1,
                  type: "step_invalidated",
                  requestDigest: githubSourceDigest({
                    operationId: input.operationId,
                    stepId: step.id,
                  }),
                  policyVersion: "source-publication-v1",
                  payload: {
                    sourceRevisionId: revision.id,
                    reason: "Source advanced; prior-head acceptance is historical.",
                  },
                },
              });
            }
            const finalScope = await lockManagerCheckout(tx, input, registration);
            if (attempt.leaseExpiresAt <= finalScope.now)
              throw new DeliveryConflict("source_publication_lease_expired");
            await tx.deliveryTask.update({
              where: { id: task.id },
              data: {
                sourceSha: revision.headSha,
                sourceRevisionId: revision.id,
                sourceVersion: revision.version,
                branch: revision.branch,
                version: { increment: 1 },
              },
            });
            const eventId = randomUUID();
            await tx.deliveryEvent.create({
              data: {
                id: eventId,
                ownerId: input.ownerId,
                taskId: task.id,
                stepId: attempt.stepId,
                attemptId: attempt.id,
                aggregateKey: `task/${task.id}`,
                aggregateVersion: task.version + 1,
                type: "source_advanced",
                requestDigest,
                policyVersion: "source-publication-v1",
                payload: {
                  sourceRevisionId: revision.id,
                  previousSourceSha: revision.inputSha,
                  sourceSha: revision.headSha,
                  invalidatedEvidenceCount: invalidated.count,
                },
              },
            });
            await tx.deliveryOutbox.create({ data: { ownerId: input.ownerId, eventId } });
            return {
              sourceContext: {
                revisionId: revision.id,
                version: revision.version,
                headSha: revision.headSha,
              },
              inputSourceSha: revision.inputSha,
              replayed: false,
              current: true,
              executionAuthorized: false,
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 10_000,
          },
        );
        // Reconciliation pauses/notices commit without accepting a source or
        // scheduling an irreversible action. Reject only after that transaction.
        if ("blockedReason" in result)
          throw new DeliveryConflict(
            result.blockedReason ?? "source_publication_reconciliation_required",
          );
        return result;
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
    }
  }
}
