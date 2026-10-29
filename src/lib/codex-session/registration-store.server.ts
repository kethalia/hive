import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@hive/db";
import type { RegistrationBinding, RegistrationStore } from "./registration.server";

if (typeof window !== "undefined") throw new Error("Registration storage is server-only.");
type Tx = Prisma.TransactionClient;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const canonical = (b: RegistrationBinding) =>
  JSON.stringify([
    b.coderOrigin,
    b.hiveUserId,
    b.ownerId,
    b.workspaceId,
    b.buildId,
    b.agentId,
    b.templateId,
    b.appOrigin,
    b.appId,
    b.projects.map((p) => [p.projectId, p.repositoryId]).sort(),
  ]);
const date = (seconds: number) => new Date(seconds * 1000);
export class RegistrationRejected extends Error {
  constructor() {
    super("Registration authority unavailable or changed.");
  }
}
const requireValue = (v: unknown) => {
  if (!v) throw new RegistrationRejected();
};
async function clock(tx: Tx) {
  return (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
}
async function lockSlot(tx: Tx, ownerId: string, id: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM codex_host_slots WHERE owner_id=${ownerId}::uuid AND id=${id}::uuid FOR UPDATE`;
  signal?.throwIfAborted();
  requireValue(rows.length === 1);
  return tx.codexHostSlot.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id } } });
}
async function verifyOwner(tx: Tx, b: RegistrationBinding, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const owner = await tx.user.findUnique({ where: { id: b.hiveUserId } });
  signal?.throwIfAborted();
  requireValue(owner?.coderUserId === b.ownerId && owner?.coderUrl === b.coderOrigin);
  const projects = await tx.deliveryProject.findMany({
    where: { ownerId: b.hiveUserId, id: { in: b.projects.map((p) => p.projectId) } },
  });
  signal?.throwIfAborted();
  requireValue(
    projects.length === b.projects.length &&
      b.projects.every((p) =>
        projects.some(
          (row) =>
            row.id === p.projectId &&
            row.provider === "github" &&
            row.providerRepositoryId === p.repositoryId,
        ),
      ),
  );
}
/** Use inside the SAME transaction as a controller mutation. The slot lock fences
 * concurrent registration replacement/revocation/heartbeat; external Coder checks
 * must additionally precede this call. Do not cache this result across transactions. */
export async function lockActiveRegistration(
  tx: Tx,
  input: { ownerId: string; registrationId: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const registration = await tx.codexHostRegistration.findUnique({
    where: { ownerId_id: { ownerId: input.ownerId, id: input.registrationId } },
    include: { threads: true },
  });
  signal?.throwIfAborted();
  requireValue(registration);
  if (!registration) throw new RegistrationRejected();
  const slot = await lockSlot(tx, input.ownerId, registration.slotId, signal);
  signal?.throwIfAborted();
  // SERIALIZABLE callers retain their first-read snapshot even after waiting for
  // the slot lock. Lock the authority row itself: a concurrent revocation/renewal
  // then forces a serialization failure instead of permitting stale authority.
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM codex_host_registrations WHERE owner_id=${input.ownerId}::uuid AND slot_id=${slot.id}::uuid AND id=${input.registrationId}::uuid FOR UPDATE`;
  signal?.throwIfAborted();
  requireValue(locked.length === 1);

  const fresh = await tx.codexHostRegistration.findUniqueOrThrow({
    where: { id: registration.id },
    include: { threads: true },
  });
  signal?.throwIfAborted();
  const now = await clock(tx);
  signal?.throwIfAborted();
  requireValue(
    slot.activeRegistrationId === fresh.id &&
      slot.generation === fresh.generation &&
      !fresh.revokedAt &&
      fresh.expiresAt > now,
  );
  await verifyOwner(tx, fresh.binding as unknown as RegistrationBinding, signal);
  return { registration: fresh, slot, now };
}
export class PrismaRegistrationStore implements RegistrationStore {
  constructor(private readonly db: PrismaClient) {}
  async reserve(input: Parameters<RegistrationStore["reserve"]>[0]) {
    return this.db.$transaction(async (tx) => {
      const b = input.binding;
      await verifyOwner(tx, b);
      const row = await tx.codexHostSlot.upsert({
        where: {
          ownerId_coderOrigin_workspaceId_agentId: {
            ownerId: b.hiveUserId,
            coderOrigin: b.coderOrigin,
            workspaceId: b.workspaceId,
            agentId: b.agentId,
          },
        },
        create: {
          ownerId: b.hiveUserId,
          coderOrigin: b.coderOrigin,
          coderOwnerId: b.ownerId,
          workspaceId: b.workspaceId,
          agentId: b.agentId,
        },
        update: {},
      });
      const slot = await lockSlot(tx, b.hiveUserId, row.id);
      const now = await clock(tx);
      requireValue(
        slot.coderOwnerId === b.ownerId &&
          date(input.expiresAt) > now &&
          date(input.expiresAt).getTime() <= now.getTime() + 60_000,
      );
      const generation = slot.generation + 1;
      await tx.codexHostSlot.update({ where: { id: slot.id }, data: { generation } });
      await tx.codexRegistrationGrant.create({
        data: {
          id: input.grantId,
          ownerId: b.hiveUserId,
          slotId: slot.id,
          generation,
          binding: b,
          bindingDigest: sha(JSON.stringify(b)),
          expiresAt: date(input.expiresAt),
        },
      });
      return generation;
    });
  }
  async seal(input: Parameters<RegistrationStore["seal"]>[0]) {
    await this.db.$transaction(async (tx) => {
      const hint = await tx.codexRegistrationGrant.findUniqueOrThrow({
        where: { id: input.grantId },
        select: { ownerId: true, slotId: true },
      });
      const slot = await lockSlot(tx, hint.ownerId, hint.slotId);
      // The pre-lock lookup locates the slot only. Re-read mutable authority after
      // the lock so a waiter cannot overwrite a completed seal/consumption.
      const grant = await tx.codexRegistrationGrant.findUniqueOrThrow({
        where: { id: input.grantId },
      });
      const now = await clock(tx);
      requireValue(
        slot.generation === input.generation &&
          grant.generation === input.generation &&
          !grant.tokenDigest &&
          !grant.consumedAt &&
          grant.expiresAt > now &&
          /^[a-f0-9]{64}$/.test(input.grantDigest),
      );
      await tx.codexRegistrationGrant.update({
        where: { id: grant.id },
        data: { tokenDigest: input.grantDigest },
      });
    });
  }
  async consumeAndRegister(input: Parameters<RegistrationStore["consumeAndRegister"]>[0]) {
    try {
      return await this.db.$transaction(async (tx) => {
        const r = input.registration,
          b = r.binding;
        const hint = await tx.codexRegistrationGrant.findUnique({
          where: { id: input.grantId },
          select: { slotId: true },
        });
        if (!hint) throw new RegistrationRejected();
        const slot = await lockSlot(tx, b.hiveUserId, hint.slotId);
        const grant = await tx.codexRegistrationGrant.findUniqueOrThrow({
          where: { id: input.grantId },
        });
        const now = await clock(tx);
        requireValue(
          grant.ownerId === b.hiveUserId &&
            slot.coderOwnerId === b.ownerId &&
            slot.workspaceId === b.workspaceId &&
            slot.agentId === b.agentId &&
            slot.coderOrigin === b.coderOrigin &&
            slot.generation === r.generation &&
            grant.generation === r.generation &&
            !grant.consumedAt &&
            grant.tokenDigest === input.grantDigest &&
            grant.expiresAt > now &&
            grant.expiresAt.getTime() === date(input.expiresAt).getTime() &&
            grant.bindingDigest === sha(JSON.stringify(b)),
        );
        requireValue(
          r.protocolVersion === "0.165.0" &&
            r.expiresAt > r.registeredAt &&
            r.expiresAt - r.registeredAt <= 60 &&
            date(r.expiresAt) > now &&
            date(r.expiresAt).getTime() <= now.getTime() + 60_000,
        );
        await verifyOwner(tx, b);
        requireValue(
          r.threads.length > 0 &&
            new Set(r.threads.map((t) => t.projectId)).size === r.threads.length &&
            new Set(r.threads.map((t) => t.threadId)).size === r.threads.length,
        );
        for (const t of r.threads)
          requireValue(
            b.projects.some(
              (p) => p.projectId === t.projectId && p.repositoryId === t.repositoryId,
            ),
          );
        const registration = await tx.codexHostRegistration.create({
          data: {
            id: grant.id,
            ownerId: b.hiveUserId,
            slotId: slot.id,
            generation: r.generation,
            binding: b,
            buildId: b.buildId,
            templateId: b.templateId,
            appId: b.appId,
            appOrigin: b.appOrigin,
            serverInstanceId: r.serverInstanceId,
            protocolVersion: r.protocolVersion,
            hostPublicKeyPem: r.hostPublicKeyPem,
            hostKeyFingerprint: sha(r.hostPublicKeyPem),
            registeredAt: date(r.registeredAt),
            expiresAt: date(r.expiresAt),
            heartbeatNonce: randomUUID(),
          },
        });
        for (const t of r.threads) {
          const key = {
            ownerId: b.hiveUserId,
            workspaceId: b.workspaceId,
            nativeThreadId: t.threadId,
          };
          const prior = await tx.deliveryConversation.findUnique({
            where: { ownerId_workspaceId_nativeThreadId: key },
          });
          requireValue(!prior || prior.projectId === t.projectId);
          const conversation = await tx.deliveryConversation.upsert({
            where: { ownerId_workspaceId_nativeThreadId: key },
            create: {
              ...key,
              projectId: t.projectId,
              buildId: b.buildId,
              serverInstanceId: r.serverInstanceId,
            },
            update: { buildId: b.buildId, serverInstanceId: r.serverInstanceId },
          });
          await tx.codexRegisteredThread.create({
            data: {
              ownerId: b.hiveUserId,
              projectId: t.projectId,
              conversationId: conversation.id,
              registrationId: registration.id,
              nativeThreadId: t.threadId,
            },
          });
        }
        if (slot.activeRegistrationId)
          await tx.codexHostRegistration.update({
            where: { id: slot.activeRegistrationId },
            data: { revokedAt: now },
          });
        await tx.codexHostSlot.update({
          where: { id: slot.id },
          data: { activeRegistrationId: registration.id },
        });
        await tx.codexRegistrationGrant.update({
          where: { id: grant.id },
          data: { consumedAt: now },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof RegistrationRejected) return false;
      throw error;
    }
  }
  async active(registrationId: string) {
    const r = await this.db.codexHostRegistration.findUnique({ where: { id: registrationId } });
    if (!r) throw new RegistrationRejected();
    return this.db.$transaction((tx) =>
      lockActiveRegistration(tx, { ownerId: r.ownerId, registrationId }),
    );
  }
  async renew(input: {
    ownerId: string;
    registrationId: string;
    sequence: number;
    nonce: string;
    serverInstanceId: string;
    binding: RegistrationBinding;
  }) {
    return this.db.$transaction(async (tx) => {
      const { registration: r, now } = await lockActiveRegistration(tx, input);
      requireValue(
        input.serverInstanceId === r.serverInstanceId &&
          canonical(input.binding) === canonical(r.binding as unknown as RegistrationBinding),
      );
      const requestDigest = sha(
        JSON.stringify([input.registrationId, input.serverInstanceId, input.sequence, input.nonce]),
      );
      // The signature and current Coder authority were checked by the service.
      // Recover only the exact latest acknowledgement; this branch never writes
      // or extends expiry. Older/changed requests cannot discover a fresh nonce.
      if (input.sequence === r.heartbeatSequence && requestDigest === r.heartbeatRequestDigest) {
        return {
          registrationId: r.id,
          expiresAt: Math.floor(r.expiresAt.getTime() / 1000),
          sequence: r.heartbeatSequence,
          nonce: r.heartbeatNonce,
        };
      }
      requireValue(input.sequence === r.heartbeatSequence + 1 && input.nonce === r.heartbeatNonce);
      const expiresAt = new Date(now.getTime() + 60_000),
        nonce = randomUUID();
      await tx.codexHostRegistration.update({
        where: { id: r.id },
        data: {
          expiresAt,
          heartbeatSequence: input.sequence,
          heartbeatNonce: nonce,
          heartbeatRequestDigest: requestDigest,
        },
      });
      return {
        registrationId: r.id,
        expiresAt: Math.floor(expiresAt.getTime() / 1000),
        sequence: input.sequence,
        nonce,
      };
    });
  }
}
