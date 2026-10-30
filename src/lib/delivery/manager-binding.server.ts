import { createHash, createPublicKey, verify } from "node:crypto";
import type { Prisma, PrismaClient } from "@hive/db";
import type { GuardianPolicy } from "@/lib/codex-session/guardian-contracts";
import { lockProducerAdmission } from "@/lib/codex-session/guardian-store.server";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import {
  lockActiveRegistration,
  RegistrationRejected,
} from "@/lib/codex-session/registration-store.server";
import type { ManagerCheckout } from "./manager-contracts";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
export interface CheckoutHostEnvelope {
  registrationId: string;
  serverInstanceId: string;
  managerThreadId: string;
  checkoutBinding: ManagerCheckout;
  issuedAt: number;
  expiresAt: number;
  proof: string;
}
export function stableDeliveryUuid(text: string) {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function managerCheckoutIdentity(
  base: {
    ownerId: string;
    conversationId: string;
    workspaceId: string;
    buildId: string;
    serverInstanceId: string;
    nativeThreadId: string;
  },
  context: ManagerCheckout,
) {
  const identity = {
    ownerId: base.ownerId,
    projectId: context.projectId,
    preparationIntentId: context.preparationIntentId,
    conversationId: base.conversationId,
    workspaceId: base.workspaceId,
    buildId: base.buildId,
    serverInstanceId: base.serverInstanceId,
    nativeThreadId: base.nativeThreadId,
    repositoryId: context.repositoryId,
    sourceSha: context.revision,
    leaseId: context.leaseId,
    leaseGeneration: context.leaseGeneration,
  };
  const bindingDigest = createHash("sha256")
    .update(JSON.stringify(["manager-checkout-v1", identity]))
    .digest("hex");
  return { id: stableDeliveryUuid(bindingDigest), identity, bindingDigest };
}
export async function authenticateCheckoutHost(
  db: PrismaClient,
  reauthorize: (binding: RegistrationBinding) => Promise<RegistrationBinding>,
  input: CheckoutHostEnvelope,
  proofPayload: string,
) {
  const now = Date.now();
  if (
    input.expiresAt <= input.issuedAt ||
    input.expiresAt - input.issuedAt > 60_000 ||
    input.issuedAt > now ||
    input.expiresAt <= now
  )
    throw new RegistrationRejected();
  const registered = await db.codexHostRegistration.findUnique({
    where: { id: input.registrationId },
  });
  if (!registered || registered.serverInstanceId !== input.serverInstanceId)
    throw new RegistrationRejected();
  const key = createPublicKey(registered.hostPublicKeyPem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, Buffer.from(proofPayload), key, Buffer.from(input.proof, "base64url"))
  )
    throw new RegistrationRejected();
  await reauthorize(registered.binding as unknown as RegistrationBinding);
  return registered;
}
export async function lockManagerCheckout(
  tx: Tx,
  input: Omit<CheckoutHostEnvelope, "proof">,
  authenticated: { ownerId: string; hostPublicKeyPem: string },
  options: {
    create?: boolean;
    allowBlocked?: boolean;
    progressionProtocol?: 1;
    guardianPolicy?: GuardianPolicy;
  } = {},
) {
  const { ownerId } = authenticated,
    context = input.checkoutBinding;
  const current = await tx.codexHostRegistration.findUnique({
    where: { ownerId_id: { ownerId, id: input.registrationId } },
  });
  if (!current) throw new RegistrationRejected();
  const guarded = await tx.codexGuardianAdmission.findFirst({
    where: { ownerId, projectId: context.projectId, registrationId: input.registrationId },
    select: { id: true },
  });
  const unresolved = await tx.codexGuardianRuntime.findFirst({
    where: { ownerId, slotId: current.slotId, phase: { not: "tree_closed" } },
    select: { id: true },
  });
  if (
    guarded ||
    unresolved ||
    options.guardianPolicy ||
    process.env.HIVE_GUARDIAN_ENABLED === "true"
  ) {
    const binding = current.binding as unknown as RegistrationBinding;
    await lockProducerAdmission(
      tx,
      {
        hiveUserId: ownerId,
        registrationId: current.id,
        workspaceId: binding.workspaceId,
        buildId: current.buildId,
        serverInstanceId: input.serverInstanceId,
        managerThreadId: input.managerThreadId,
        projectId: context.projectId,
        preparationIntentId: context.preparationIntentId,
        repositoryId: context.repositoryId,
        leaseId: context.leaseId,
        leaseGeneration: context.leaseGeneration,
      },
      options.guardianPolicy,
    );
  }
  const { registration, slot, now } = await lockActiveRegistration(tx, {
    ownerId,
    registrationId: input.registrationId,
  });
  if (
    registration.serverInstanceId !== input.serverInstanceId ||
    registration.hostPublicKeyPem !== authenticated.hostPublicKeyPem ||
    input.issuedAt > now.getTime() ||
    input.expiresAt <= now.getTime()
  )
    throw new RegistrationRejected();
  const thread = registration.threads.find(
    (value) =>
      value.nativeThreadId === input.managerThreadId && value.projectId === context.projectId,
  );
  if (!thread) throw new RegistrationRejected();
  const conversation = await tx.deliveryConversation.findUnique({
    where: { ownerId_id: { ownerId, id: thread.conversationId } },
  });
  if (
    !conversation ||
    conversation.projectId !== context.projectId ||
    conversation.nativeThreadId !== input.managerThreadId ||
    conversation.workspaceId !== slot.workspaceId ||
    conversation.buildId !== registration.buildId ||
    conversation.serverInstanceId !== registration.serverInstanceId
  )
    throw new RegistrationRejected();
  const found = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM project_task_intents WHERE owner_id=${ownerId}::uuid AND project_id=${context.projectId}::uuid AND id=${context.preparationIntentId}::uuid FOR UPDATE`;
  if (found.length !== 1) throw new RegistrationRejected();
  const intent = await tx.projectTaskIntent.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: context.preparationIntentId } },
  });
  const project = await tx.deliveryProject.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: context.projectId } },
  });
  if (
    intent.workspaceId !== slot.workspaceId ||
    intent.repositoryId !== context.repositoryId ||
    project.provider !== "github" ||
    project.providerRepositoryId !== context.repositoryId ||
    project.providerAccountId !== intent.providerAccountId ||
    intent.sourceSha !== context.revision
  )
    throw new RegistrationRejected();
  if (!options.allowBlocked && intent.phase === "blocked")
    throw new DeliveryConflict("preparation_intent_blocked");
  const status = intent.status as { nativeThreadId?: unknown } | null;
  if (
    status?.nativeThreadId !== null &&
    status?.nativeThreadId !== undefined &&
    status.nativeThreadId !== input.managerThreadId
  )
    throw new RegistrationRejected();
  const { identity, bindingDigest, id } = managerCheckoutIdentity(
    {
      ownerId,
      conversationId: conversation.id,
      workspaceId: slot.workspaceId,
      buildId: registration.buildId,
      serverInstanceId: registration.serverInstanceId,
      nativeThreadId: input.managerThreadId,
    },
    context,
  );
  if (options.create) {
    // The intent is a shared checkout lock across native lifetimes; write it so
    // a waiting Serializable snapshot cannot silently miss another new binding.
    await tx.projectTaskIntent.update({ where: { id: intent.id }, data: { updatedAt: now } });
    await tx.deliveryManagerBinding.upsert({
      where: { ownerId_id: { ownerId, id } },
      create: {
        id,
        ...identity,
        bindingDigest,
        progressionProtocol: options.progressionProtocol ?? 0,
      },
      update: {},
    });
  }
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM delivery_manager_bindings WHERE owner_id=${ownerId}::uuid AND id=${id}::uuid FOR UPDATE`;
  if (locked.length !== 1) throw new DeliveryConflict("manager_binding_missing");
  const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id } },
  });
  if (binding.bindingDigest !== bindingDigest)
    throw new DeliveryConflict("manager_binding_conflict");
  if (binding.blockedReason && !options.allowBlocked)
    throw new DeliveryConflict("native_reconciliation_required");
  return { binding, registration, slot, thread, conversation, intent, now };
}
