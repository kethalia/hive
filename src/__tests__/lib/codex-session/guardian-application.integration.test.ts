import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requireAppliedSourceForAction } from "@/lib/codex-session/guardian-application-gate.server";
import { lockProducerMetadata } from "@/lib/codex-session/guardian-store.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { guardianApplicationFixture } from "./guardian-application-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Isolated local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
const fixture = () =>
  guardianApplicationFixture(db, (policy) => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
    vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
    vi.stubEnv(
      "HIVE_GUARDIAN_APPROVED_PACKAGES_JSON",
      JSON.stringify((policy as { packages: unknown }).packages),
    );
  });
describe.skipIf(!url)(
  "durable accepted-source application reservation, actual local PostgreSQL",
  () => {
    it("reserves after producing-root completion, refreshes only same operation and retains physical writer", async () => {
      const f = await fixture(),
        input = f.reservation();
      const before = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.claim.managerBindingId },
      });
      const result = await f.store.reserve(f.guardian.scope, input);
      expect(result.phase).toBe("pending");
      expect(result.executionAuthorized).toBe(false);
      expect(result.cleanupAuthorized).toBe(false);
      expect(result.expiresAt).toBeGreaterThan(Date.now() / 1000);
      expect(result.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 30);
      expect(result.inputBarrier.id).toBe(input.inputBarrier.id);
      await db.deliveryAttempt.update({
        where: { id: f.claim.attemptId },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });
      expect((await f.store.verify(f.guardian.scope, input.applicationId)).applicationId).toBe(
        input.applicationId,
      );
      const done = await f.store.commit(f.guardian.scope, input.applicationId, f.receipt(input));
      expect(done.phase).toBe("applied");
      expect(done.executionAuthorized).toBe(false);
      const after = await db.deliveryManagerBinding.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.activeAttemptId).toBe(before.activeAttemptId);
      expect(after.currentAttemptId).toBe(before.currentAttemptId);
      expect(
        await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } }),
      ).toMatchObject({ quiescedAt: null });
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.guardian.runtime.id } }))
          .phase,
      ).toBe("open");
    });
    it("pending application cannot admit another operation or accept foreign source/barrier receipt", async () => {
      const f = await fixture(),
        input = f.reservation();
      await f.store.reserve(f.guardian.scope, input);
      await expect(
        f.store.reserve(f.guardian.scope, { ...input, applicationId: randomUUID() }),
      ).rejects.toThrow();
      for (const patch of [
        { inputBarrierId: randomUUID() },
        { appliedHeadSha: "f".repeat(40) },
        { supervisorSourceContext: { ...input.targetSourceContext, version: 999 } },
        { observedAt: new Date(Date.now() - 6000).toISOString() },
      ])
        await expect(
          f.store.commit(f.guardian.scope, input.applicationId, { ...f.receipt(input), ...patch }),
        ).rejects.toBeInstanceOf(RegistrationRejected);
      expect(
        (
          await db.deliverySourceApplication.findUniqueOrThrow({
            where: { id: input.applicationId },
          })
        ).phase,
      ).toBe("pending");
    });
    it("producer revocation preserves pending and cannot use old positive verification", async () => {
      const f = await fixture(),
        input = f.reservation();
      await f.store.reserve(f.guardian.scope, input);
      await db.codexGuardianRuntime.update({
        where: { id: f.guardian.runtime.id },
        data: { producerApproved: false },
      });
      await expect(f.store.verify(f.guardian.scope, input.applicationId)).rejects.toBeInstanceOf(
        RegistrationRejected,
      );
      await expect(
        f.store.commit(f.guardian.scope, input.applicationId, f.receipt(input)),
      ).rejects.toBeInstanceOf(RegistrationRejected);
      expect(
        (
          await db.deliverySourceApplication.findUniqueOrThrow({
            where: { id: input.applicationId },
          })
        ).phase,
      ).toBe("pending");
    });
    it("database retains immutable reservations, applied receipts and original source/physical scope", async () => {
      const f = await fixture(),
        input = f.reservation();
      await f.store.reserve(f.guardian.scope, input);
      await expect(
        db.deliverySourceApplication.update({
          where: { id: input.applicationId },
          data: { targetHeadSha: "f".repeat(40) },
        }),
      ).rejects.toThrow();
      await expect(
        db.deliverySourceApplication.delete({ where: { id: input.applicationId } }),
      ).rejects.toThrow();
      const receipt = f.receipt(input);
      await f.store.commit(f.guardian.scope, input.applicationId, receipt);
      await expect(
        db.deliverySourceApplication.update({
          where: { id: input.applicationId },
          data: {
            phase: "pending",
            appliedAt: null,
            appliedReceiptDigest: null,
            appliedEvidence: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow();
      const row = await db.deliverySourceApplication.findUniqueOrThrow({
        where: { id: input.applicationId },
      });
      expect(row.producingAttemptId).toBe(f.claim.attemptId);
      expect(row.predecessorHeadSha).toBe(f.context.revision);
    });
  },
);

it.skipIf(!url)(
  "action gate closes accepted-to-reserve gap, preserves exact producing-root report, then reopens only after protected ACK",
  async () => {
    const f = await fixture(),
      input = f.reservation();
    const check = (
      action: "execution" | "root_boundary" | "publication" | "completion",
      attemptId = f.claim.attemptId,
    ) =>
      db.$transaction(async (tx) => {
        await lockProducerMetadata(tx, f.guardian.scope, f.guardian.policy);
        return requireAppliedSourceForAction(tx, {
          ownerId: f.user.id,
          managerBindingId: f.claim.managerBindingId,
          taskId: f.taskId,
          action,
          attemptId,
          parentTurnId: f.parentTurnId,
        });
      });
    for (const action of ["execution", "root_boundary", "publication"] as const)
      await expect(check(action)).rejects.toThrow("source_application_required");
    expect(await check("completion")).toMatchObject({ reportOnly: true, applied: false });
    await expect(check("completion", randomUUID())).rejects.toThrow("source_application_required");
    await f.store.reserve(f.guardian.scope, input);
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "false");
    await expect(check("execution")).rejects.toThrow("source_application_required");
    await f.store.commit(f.guardian.scope, input.applicationId, f.receipt(input));
    expect(await check("execution")).toMatchObject({ applied: true, reportOnly: false });
  },
);
it.skipIf(!url)(
  "concurrent different application identities cannot both reserve the held admission",
  async () => {
    const f = await fixture(),
      first = f.reservation(),
      second = { ...first, applicationId: randomUUID() };
    const results = await Promise.allSettled([
      f.store.reserve(f.guardian.scope, first),
      f.store.reserve(f.guardian.scope, second),
    ]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((v) => v.status === "rejected")).toHaveLength(1);
    expect(
      await db.deliverySourceApplication.count({
        where: { admissionId: f.guardian.finalized.admission.id, phase: "pending" },
      }),
    ).toBe(1);
  },
);
it.skipIf(!url)(
  "late native facts invalidate pending application verification without clearing its fence",
  async () => {
    const f = await fixture(),
      input = f.reservation();
    await f.store.reserve(f.guardian.scope, input);
    await db.deliveryManagerBinding.update({
      where: { id: f.claim.managerBindingId },
      data: { nativeSequence: { increment: 1 } },
    });
    await expect(f.store.verify(f.guardian.scope, input.applicationId)).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    expect(
      (await db.deliverySourceApplication.findUniqueOrThrow({ where: { id: input.applicationId } }))
        .phase,
    ).toBe("pending");
  },
);

it.skipIf(!url)(
  "lost apply ACK recovers by fresh applied-state verification after original receipt freshness expires",
  async () => {
    const f = await fixture(),
      input = f.reservation();
    await f.store.reserve(f.guardian.scope, input);
    const receipt = f.receipt(input);
    await f.store.commit(f.guardian.scope, input.applicationId, receipt);
    const before = await db.deliverySourceApplication.findUniqueOrThrow({
      where: { id: input.applicationId },
    });
    await new Promise((done) => setTimeout(done, 5100));
    await expect(
      f.store.commit(f.guardian.scope, input.applicationId, receipt),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    const recovered = await f.store.verify(f.guardian.scope, input.applicationId);
    expect(recovered.phase).toBe("applied");
    expect(recovered.executionAuthorized).toBe(false);
    expect(recovered.expiresAt).toBeGreaterThan(Date.now() / 1000);
    const after = await db.deliverySourceApplication.findUniqueOrThrow({
      where: { id: input.applicationId },
    });
    expect(after.appliedReceiptDigest).toBe(before.appliedReceiptDigest);
    expect(after.appliedAt).toEqual(before.appliedAt);
    expect(after.appliedEvidence).toEqual(before.appliedEvidence);
  },
  12000,
);
