import { Prisma, type PrismaClient } from "@hive/db";
import type { GuardianPolicy } from "@/lib/codex-session/guardian-contracts";
import { lockProducerMetadata } from "@/lib/codex-session/guardian-store.server";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import {
  lockActiveRegistration,
  RegistrationRejected,
} from "@/lib/codex-session/registration-store.server";
import { canonicalGitHubSource } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import { authenticateCheckoutHost, lockManagerCheckout } from "./manager-binding.server";
import { SOURCE_PUBLICATION_PRODUCER } from "./source-publication.server";
import { resolveTaskSource } from "./source-resolver.server";
import {
  sourceStateProofPayload,
  sourceStateRequestSchema,
  sourceStateResponseSchema,
} from "./source-state-contracts";
import { DeliveryConflict } from "./state";

/** Factual accepted-source readback only. Neither publication nor native input
 * authority is granted. All reads run under the actual persisted producer lock. */
export class DeliverySourceStateService {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: {
      reauthorize(binding: RegistrationBinding): Promise<RegistrationBinding>;
      guardianPolicy?: GuardianPolicy;
    },
  ) {}
  async read(value: unknown) {
    value = JSON.parse(canonicalGitHubSource(value));
    const input = sourceStateRequestSchema.parse(value);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      sourceStateProofPayload(value as Record<string, unknown>),
    );
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(
          async (tx) => {
            const { registration, slot } = await lockActiveRegistration(tx, {
              ownerId: authenticated.ownerId,
              registrationId: input.registrationId,
            });
            if (
              registration.hostPublicKeyPem !== authenticated.hostPublicKeyPem ||
              registration.serverInstanceId !== input.serverInstanceId ||
              !registration.threads.some(
                (t) =>
                  t.projectId === input.checkoutBinding.projectId &&
                  t.nativeThreadId === input.managerThreadId,
              )
            )
              throw new RegistrationRejected();
            const producer = await lockProducerMetadata(
              tx,
              {
                hiveUserId: authenticated.ownerId,
                registrationId: input.registrationId,
                workspaceId: slot.workspaceId,
                buildId: registration.buildId,
                serverInstanceId: input.serverInstanceId,
                managerThreadId: input.managerThreadId,
                projectId: input.checkoutBinding.projectId,
                preparationIntentId: input.checkoutBinding.preparationIntentId,
                repositoryId: input.checkoutBinding.repositoryId,
                leaseId: input.checkoutBinding.leaseId,
                leaseGeneration: input.checkoutBinding.leaseGeneration,
              },
              this.dependencies.guardianPolicy,
            );
            const host = await lockManagerCheckout(tx, input, authenticated, {
              allowBlocked: true,
              guardianPolicy: this.dependencies.guardianPolicy,
            });
            const found = await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM delivery_tasks WHERE owner_id=${authenticated.ownerId}::uuid AND id=${input.taskId}::uuid FOR UPDATE`;
            if (found.length !== 1) throw new DeliveryConflict("source_state_not_found");
            const task = await tx.deliveryTask.findUniqueOrThrow({
              where: { ownerId_id: { ownerId: authenticated.ownerId, id: input.taskId } },
              include: { project: true },
            });
            if (
              task.managerBindingId !== host.binding.id ||
              task.projectId !== host.binding.projectId ||
              task.conversationId !== host.binding.conversationId ||
              task.project.provider !== "github" ||
              task.project.providerRepositoryId !== input.checkoutBinding.repositoryId
            )
              throw new RegistrationRejected();
            const accepted = await tx.deliverySourceRevision.findUnique({
              where: {
                ownerId_managerBindingId_operationId: {
                  ownerId: authenticated.ownerId,
                  managerBindingId: host.binding.id,
                  operationId: input.operationId,
                },
              },
              include: { producingAttempt: { include: { step: true } } },
            });
            if (!accepted || accepted.taskId !== task.id)
              throw new DeliveryConflict("source_state_not_found");
            if (input.revisionId && input.revisionId !== accepted.id)
              throw new DeliveryConflict("source_revision_scope_mismatch");
            const attempt = accepted.producingAttempt;
            if (
              accepted.producer !== SOURCE_PUBLICATION_PRODUCER ||
              accepted.version > task.sourceVersion ||
              accepted.repositoryId !== task.project.providerRepositoryId ||
              accepted.providerAccountId !== task.project.providerAccountId ||
              attempt.ownerId !== authenticated.ownerId ||
              attempt.managerBindingId !== host.binding.id ||
              attempt.stepId !== accepted.stepId ||
              attempt.step.taskId !== task.id ||
              attempt.outputRevisionId !== accepted.id ||
              attempt.sourceSha !== accepted.inputSha
            )
              throw new DeliveryConflict("source_state_scope_mismatch");
            const source = await resolveTaskSource(tx, authenticated.ownerId, task.id);
            const runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({
              where: { ownerId_id: { ownerId: authenticated.ownerId, id: producer.runtimeId } },
              select: { authorityUntil: true },
            });
            const now = (
              await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
            )[0].now.getTime();
            const expiresAt = Math.min(
              now + 30000,
              registration.expiresAt.getTime(),
              runtime.authorityUntil.getTime(),
              input.expiresAt,
            );
            if (input.issuedAt > now || expiresAt <= now) throw new RegistrationRejected();
            const {
              metadataPins,
              metadataPinsDigest,
              metadataPolicyDigest,
              namespaceReceiptDigest,
              ...admission
            } = producer;
            return sourceStateResponseSchema.parse({
              schemaVersion: 1,
              action: "read_source_state",
              requestId: input.requestId,
              observedAt: now,
              expiresAt,
              scope: {
                ownerId: authenticated.ownerId,
                registrationId: input.registrationId,
                serverInstanceId: input.serverInstanceId,
                managerThreadId: input.managerThreadId,
                managerBindingId: host.binding.id,
                checkoutBindingDigest: host.binding.bindingDigest,
                checkoutBinding: input.checkoutBinding,
                taskId: task.id,
              },
              admission,
              metadata: {
                pins: metadataPins,
                pinsDigest: metadataPinsDigest,
                policyDigest: metadataPolicyDigest,
                namespaceReceiptDigest,
              },
              accepted: {
                operationId: accepted.operationId,
                sourceContext: {
                  revisionId: accepted.id,
                  version: accepted.version,
                  headSha: accepted.headSha,
                },
                previousRevisionId: accepted.previousRevisionId,
                parentSha: accepted.inputSha,
                treeSha: accepted.treeSha,
                manifestDigest: accepted.manifestDigest,
                repositoryId: accepted.repositoryId,
                providerAccountId: accepted.providerAccountId,
                fullName: accepted.fullName,
                branch: accepted.branch,
                baseBranch: accepted.baseBranch,
                pullRequestId: accepted.pullRequestId,
                pullNumber: accepted.pullNumber,
                producingAttemptId: accepted.producingAttemptId,
                stepId: accepted.stepId,
                proofDigest: accepted.proofDigest,
              },
              current: {
                ...(source.context ? { sourceContext: source.context } : {}),
                headSha: source.headSha,
                version: task.sourceVersion,
                physicalBase: source.physicalBase,
                branch: task.branch,
              },
              isCurrent: task.sourceRevisionId === accepted.id,
              publicationAuthorized: false,
              executionAuthorized: false,
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10000,
            timeout: 10000,
          },
        );
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
}
