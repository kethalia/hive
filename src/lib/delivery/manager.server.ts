import { createPublicKey, verify } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import {
  lockActiveRegistration,
  RegistrationRejected,
} from "@/lib/codex-session/registration-store.server";
import { managerEnvelopeSchema, managerProofPayload } from "./manager-contracts";
import { DeliveryRepository, type EvidencePolicy } from "./repository";
import { DeliveryConflict } from "./state";

if (typeof window !== "undefined") throw new Error("Delivery manager is server-only.");
export interface ManagerDependencies {
  // Real deployment uses fresh server-owned Coder owner/build/app authorization.
  reauthorize(binding: RegistrationBinding): Promise<RegistrationBinding>;
  // Controller-owned adapter policy, never read from the host envelope.
  evidencePolicy?: EvidencePolicy;
}
/** No producer trust can be supplied by a manager request. Until external adapters
 * are configured, the empty allowlist intentionally prevents successful reports. */
export class DeliveryManagerService {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: ManagerDependencies,
  ) {}

  async execute(value: unknown) {
    const input = managerEnvelopeSchema.parse(value);
    const wire = value as Record<string, unknown>;
    const timestamp = Date.now();
    if (
      input.expiresAt <= input.issuedAt ||
      input.expiresAt - input.issuedAt > 60_000 ||
      input.issuedAt > timestamp ||
      input.expiresAt <= timestamp
    )
      throw new RegistrationRejected();
    const registered = await this.db.codexHostRegistration.findUnique({
      where: { id: input.registrationId },
    });
    if (!registered || registered.serverInstanceId !== input.serverInstanceId)
      throw new RegistrationRejected();
    const key = createPublicKey(registered.hostPublicKeyPem);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(managerProofPayload(wire)),
        key,
        Buffer.from(input.proof, "base64url"),
      )
    )
      throw new RegistrationRejected();
    await this.dependencies.reauthorize(registered.binding as unknown as RegistrationBinding);
    const ownerId = registered.ownerId;
    const repository = new DeliveryRepository(
      this.db,
      this.dependencies.evidencePolicy,
      async (tx) => {
        const { registration, slot, now } = await lockActiveRegistration(tx, {
          ownerId,
          registrationId: registered.id,
        });
        if (
          registration.serverInstanceId !== input.serverInstanceId ||
          registration.hostPublicKeyPem !== registered.hostPublicKeyPem ||
          input.issuedAt > now.getTime() ||
          input.expiresAt <= now.getTime()
        )
          throw new RegistrationRejected();
        const thread = registration.threads.find((t) => t.nativeThreadId === input.managerThreadId);
        if (!thread) throw new RegistrationRejected();
        const conversation = await tx.deliveryConversation.findUnique({
          where: { ownerId_id: { ownerId, id: thread.conversationId } },
        });
        if (
          !conversation ||
          conversation.projectId !== thread.projectId ||
          conversation.nativeThreadId !== thread.nativeThreadId ||
          conversation.workspaceId !== slot.workspaceId ||
          conversation.buildId !== registration.buildId ||
          conversation.serverInstanceId !== registration.serverInstanceId
        )
          throw new RegistrationRejected();
        if (input.command.operation !== "create_task") {
          const task = await tx.deliveryTask.findUnique({
            where: { ownerId_id: { ownerId, id: input.command.payload.taskId } },
          });
          if (
            !task ||
            task.projectId !== thread.projectId ||
            task.conversationId !== thread.conversationId
          )
            throw new RegistrationRejected();
        }
        if (
          input.command.operation === "complete_step" ||
          input.command.operation === "fail_attempt"
        ) {
          const attempt = await tx.deliveryAttempt.findUnique({
            where: { ownerId_id: { ownerId, id: input.command.payload.attemptId } },
          });
          if (!attempt?.leaseHolder.startsWith(`host/${registered.id}/`))
            throw new RegistrationRejected();
          if (input.command.operation === "complete_step") {
            const binding = attempt.runtimeBinding as Record<string, unknown> | null;
            if (
              !binding ||
              binding.managerThreadId !== input.managerThreadId ||
              binding.serverInstanceId !== input.serverInstanceId ||
              binding.workspaceId !== slot.workspaceId ||
              binding.buildId !== registration.buildId ||
              binding.coderOwnerId !== slot.coderOwnerId
            )
              throw new RegistrationRejected();
            if (
              !attempt.effectiveModel ||
              !attempt.effectiveEffort ||
              attempt.effectiveModel !== attempt.requestedModel ||
              attempt.effectiveEffort !== attempt.requestedEffort
            )
              throw new DeliveryConflict("native_settings_unverified");
          }
        }
      },
    );
    // Derive project/conversation before createTask parses its strict contract;
    // the transaction repeats and locks these checks before any write.
    const thread = await this.db.codexRegisteredThread.findFirst({
      where: { ownerId, registrationId: registered.id, nativeThreadId: input.managerThreadId },
    });
    if (!thread) throw new RegistrationRejected();
    const common = { schemaVersion: 1, eventId: input.eventId };
    switch (input.command.operation) {
      case "create_task":
        return repository.createTask(ownerId, {
          ...input.command.payload,
          ...common,
          projectId: thread.projectId,
          conversationId: thread.conversationId,
        });
      case "claim_step":
        return repository.claimStep(ownerId, {
          ...input.command.payload,
          ...common,
          leaseHolder: `host/${registered.id}/${input.nativeCallId}`.slice(0, 160),
          effectiveModel: null,
          effectiveEffort: null,
        });
      case "complete_step":
      case "fail_attempt": {
        const payload = input.command.payload;
        if (input.command.operation === "complete_step")
          return repository.completeStep(ownerId, { ...payload, ...common });
        return repository.failAttempt(ownerId, { ...payload, ...common });
      }
      default:
        throw new DeliveryConflict("unsupported_manager_operation");
    }
  }
}
