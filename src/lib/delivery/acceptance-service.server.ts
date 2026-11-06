import { Prisma, type PrismaClient } from "@hive/db";
import type { GuardianPolicy } from "@/lib/codex-session/guardian-contracts";
import { lockProducerMetadata } from "@/lib/codex-session/guardian-store.server";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import {
  lockActiveRegistration,
  RegistrationRejected,
} from "@/lib/codex-session/registration-store.server";
import type { AcceptanceSuccessController } from "./acceptance-completion.server";
import { acceptanceProofPayload, acceptanceRequestSchema } from "./acceptance-contracts";
import type { AcceptanceRepairController } from "./acceptance-repair.server";
import type { AcceptanceAuthority, AcceptanceStore } from "./acceptance-store.server";
import { canonicalGitHubSource } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import { authenticateCheckoutHost, lockManagerCheckout } from "./manager-binding.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { DeliveryConflict } from "./state";

/** Fixed registered-host endpoint. The evaluator job and scope are selected from
 * controller persistence; the model cannot submit an owner/repository/policy or
 * request evaluation of arbitrary input. All positive replies reauthorize under
 * the same transaction as the lease/result write. */
export class DeliveryAcceptanceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly store: AcceptanceStore,
    private readonly dependencies: {
      reauthorize(binding: RegistrationBinding): Promise<RegistrationBinding>;
      policies: RepositoryPolicyStore;
      guardianPolicy?: GuardianPolicy;
      repair?: AcceptanceRepairController;
      success?: AcceptanceSuccessController;
      // Installed controller derivation only, never called with model task IDs.
      prepareReview?(
        tx: Prisma.TransactionClient,
        host: Awaited<ReturnType<typeof lockManagerCheckout>>,
        candidate: unknown,
      ): Promise<unknown>;
      prepareCurrentReview?(
        tx: Prisma.TransactionClient,
        host: Awaited<ReturnType<typeof lockManagerCheckout>>,
      ): Promise<void>;
    },
  ) {}
  async dispatch(value: unknown) {
    const wire = JSON.parse(canonicalGitHubSource(value));
    const input = acceptanceRequestSchema.parse(wire);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      acceptanceProofPayload(wire),
    );
    for (let retry = 0; ; retry++) {
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
                (thread) =>
                  thread.nativeThreadId === input.managerThreadId &&
                  thread.projectId === input.checkoutBinding.projectId,
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
              create:
                input.action === "claim_acceptance" || input.action === "read_acceptance_plan",
              progressionProtocol: 1,
              guardianPolicy: this.dependencies.guardianPolicy,
            });
            if (
              !(await this.dependencies.policies.authorizeIntent(
                tx,
                authenticated.ownerId,
                host.intent.id,
              ))
            )
              throw new DeliveryConflict("acceptance_repository_not_enrolled");
            if (host.binding.progressionProtocol !== 1)
              throw new DeliveryConflict("acceptance_binding_unsupported");
            const paused = await tx.deliveryTask.findFirst({
              where: {
                ownerId: authenticated.ownerId,
                managerBindingId: host.binding.id,
                OR: [{ pauseRequested: true }, { schedulingPaused: true }],
              },
              select: { id: true },
            });
            if (paused) throw new DeliveryConflict("acceptance_task_paused");
            const authority: AcceptanceAuthority = {
              ownerId: authenticated.ownerId,
              projectId: host.intent.projectId,
              preparationIntentId: host.intent.id,
              registrationId: registration.id,
              serverInstanceId: registration.serverInstanceId,
              managerThreadId: input.managerThreadId,
              producer,
            };
            let result: unknown;
            if (input.action === "read_acceptance_plan") {
              const plan = await tx.deliveryAcceptancePlan.findUnique({
                where: {
                  ownerId_intentId_producerDigest: {
                    ownerId: authority.ownerId,
                    intentId: authority.preparationIntentId,
                    producerDigest: this.store.producerDigest,
                  },
                },
              });
              result = {
                phase: plan ? "completed" : "pending",
                planDigest: plan?.planDigest ?? null,
                plan: plan?.content ?? null,
              };
            } else if (input.action === "repair_prepare" || input.action === "repair_ready") {
              if (!this.dependencies.repair)
                throw new DeliveryConflict("acceptance_repair_unavailable");
              result =
                input.action === "repair_prepare"
                  ? await this.dependencies.repair.prepare(tx, authority, host.binding.id)
                  : await this.dependencies.repair.ready(
                      tx,
                      authority,
                      host.binding.id,
                      input.repairId,
                    );
            } else if (input.action === "complete_verified") {
              if (!this.dependencies.success)
                throw new DeliveryConflict("acceptance_completion_unavailable");
              result = await this.dependencies.success.complete(
                tx,
                authority,
                host.binding.id,
                input.terminal,
              );
            } else if (input.action === "prepare_review") {
              if (!this.dependencies.prepareReview)
                throw new DeliveryConflict("acceptance_material_unavailable");
              result = await this.dependencies.prepareReview(tx, host, input.candidate);
            } else if (input.action === "claim_acceptance") {
              await this.dependencies.prepareCurrentReview?.(tx, host);
              result = await this.store.claim(tx, authority);
            } else if (input.action === "start_acceptance")
              result = await this.store.start(tx, authority, input);
            else if (input.action === "finish_acceptance")
              result = await this.store.finish(tx, authority, input);
            else result = await this.store.read(tx, authority, input.jobId);
            // Do not let work awaited under the transaction turn an expired wire
            // or runtime into positive response authority.
            await lockProducerMetadata(
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
            const active = await lockActiveRegistration(tx, {
              ownerId: authenticated.ownerId,
              registrationId: input.registrationId,
            });
            if (input.expiresAt <= active.now.getTime()) throw new RegistrationRejected();
            return {
              schemaVersion: 1,
              action: input.action,
              requestId: input.requestId,
              observedAt: active.now.getTime(),
              expiresAt: Math.min(
                input.expiresAt,
                active.registration.expiresAt.getTime(),
                active.now.getTime() + 30000,
              ),
              ownerId: authority.ownerId,
              projectId: authority.projectId,
              preparationIntentId: authority.preparationIntentId,
              registrationId: authority.registrationId,
              serverInstanceId: authority.serverInstanceId,
              managerThreadId: authority.managerThreadId,
              producer,
              result,
              executionAuthorized: false,
              publicationAuthorized: false,
              cleanupAuthorized: false,
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
            maxWait: 5000,
          },
        );
      } catch (error) {
        const repairRace =
          ["repair_prepare", "repair_ready", "complete_verified"].includes(input.action) &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          JSON.stringify(error.meta?.target) ===
            JSON.stringify(["owner_id", "aggregate_key", "aggregate_version"]);
        if (retry >= 2 || (!isGitHubSerializationConflict(error) && !repairRace)) throw error;
      }
    }
  }
}
