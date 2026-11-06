import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { acceptanceFixture, acceptanceFixtureProducer } from "./acceptance-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !(
      new URL(url).pathname.startsWith("/hive_acceptance_test") ||
      new URL(url).pathname === "/hive_delivery_test"
    ))
)
  throw new Error("Private local acceptance fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
describe.skipIf(!url)("independent acceptance persistence", () => {
  it("captures exact encrypted intent atomically and survives preparation ciphertext clearing", async () => {
    const f = await acceptanceFixture(db);
    const snapshot = await db.deliveryAcceptanceIntent.findUniqueOrThrow({
      where: { ownerId_intentId: { ownerId: f.user.id, intentId: f.row.id } },
    });
    expect(Buffer.from(snapshot.ciphertext).includes(Buffer.from(f.input.hostRequest.text))).toBe(
      false,
    );
    await db.projectTaskIntent.update({
      where: { id: f.row.id },
      data: { phase: "running", ciphertext: null, iv: null, authTag: null },
    });
    expect(
      (await f.transaction((tx) => f.store.originalIntent(tx, f.user.id, f.row.id))).sealed.text,
    ).toBe(f.input.hostRequest.text);
    const replay = await f.intents.enqueue(f.input);
    expect(replay.id).toBe(f.row.id);
    expect(await db.deliveryAcceptanceJob.count({ where: { ownerId: f.user.id } })).toBe(1);
    await expect(
      db.deliveryAcceptanceIntent.update({
        where: { ownerId_intentId: { ownerId: f.user.id, intentId: f.row.id } },
        data: { intentDigest: "f".repeat(64) },
      }),
    ).rejects.toThrow();
  });
  it("records controller thread before inference, and reconciles lost start/result acknowledgements", async () => {
    const f = await acceptanceFixture(db);
    const leased = await f.transaction((tx) => f.store.claim(tx, f.authority));
    if (leased.phase !== "leased") throw new Error("Expected fresh lease");
    expect(leased.payload.originalIntent).toBe(f.input.hostRequest.text);
    const start = {
      jobId: leased.jobId,
      leaseId: leased.leaseId,
      leaseGeneration: leased.leaseGeneration,
      threadId: "fixture-independent-review",
    };
    expect((await f.transaction((tx) => f.store.start(tx, f.authority, start))).replay).toBe(false);
    expect((await f.transaction((tx) => f.store.start(tx, f.authority, start))).replay).toBe(true);
    expect(await f.transaction((tx) => f.store.claim(tx, f.authority))).toEqual({
      phase: "reconcile",
      jobId: leased.jobId,
    });
    const output = JSON.stringify(f.plan);
    const result = {
      ...start,
      output,
      receipt: {
        threadId: start.threadId,
        turnId: "fixture-turn",
        runtimeVersion: "0.165.0" as const,
        requestedModel: acceptanceFixtureProducer.model,
        effectiveModel: acceptanceFixtureProducer.model,
        requestedEffort: "low" as const,
        effectiveEffort: "low" as const,
        inputDigest: leased.inputDigest,
        outputDigest: requireIntentDigest(output),
        configDigest: acceptanceFixtureProducer.permissionsDigest,
        startedAt: Date.now() - 5,
        completedAt: Date.now(),
        terminal: true as const,
        controllerCreated: true as const,
        unexpectedTools: 0 as const,
        unexpectedChildren: 0 as const,
      },
    };
    const accepted = await f.transaction((tx) => f.store.finish(tx, f.authority, result));
    expect(accepted.replay).toBe(false);
    const before = await db.deliveryAcceptanceJob.findUniqueOrThrow({
      where: { id: leased.jobId },
    });
    expect((await f.transaction((tx) => f.store.finish(tx, f.authority, result))).replay).toBe(
      true,
    );
    const after = await db.deliveryAcceptanceJob.findUniqueOrThrow({ where: { id: leased.jobId } });
    expect(after.completedAt).toEqual(before.completedAt);
    expect(await db.deliveryAcceptancePlan.count({ where: { ownerId: f.user.id } })).toBe(1);
    expect(after.resultDigest).toBe(acceptanceDigest(f.plan));
    await expect(
      f.transaction((tx) =>
        f.store.finish(tx, f.authority, {
          ...result,
          receipt: { ...result.receipt, turnId: "another-turn" },
        }),
      ),
    ).rejects.toThrow("acceptance_result_replay_mismatch");
  });
  it("rejects manager thread, changed lifetime, omitted intent meaning and model fallback", async () => {
    const f = await acceptanceFixture(db);
    const leased = await f.transaction((tx) => f.store.claim(tx, f.authority));
    if (leased.phase !== "leased") throw new Error("Expected fresh lease");
    const start = {
      jobId: leased.jobId,
      leaseId: leased.leaseId,
      leaseGeneration: leased.leaseGeneration,
      threadId: f.authority.managerThreadId,
    };
    await expect(f.transaction((tx) => f.store.start(tx, f.authority, start))).rejects.toThrow(
      "acceptance_start_binding",
    );
    await expect(
      f.transaction((tx) =>
        f.store.start(
          tx,
          { ...f.authority, registrationId: randomUUID() },
          { ...start, threadId: "independent" },
        ),
      ),
    ).rejects.toThrow("acceptance_job_authority_changed");
    await f.transaction((tx) =>
      f.store.start(tx, f.authority, { ...start, threadId: "independent" }),
    );
    const output = JSON.stringify(f.plan);
    await expect(
      f.transaction((tx) =>
        f.store.finish(tx, f.authority, {
          ...start,
          output,
          receipt: {
            threadId: "independent",
            turnId: "turn",
            runtimeVersion: "0.165.0",
            requestedModel: acceptanceFixtureProducer.model,
            effectiveModel: "unapproved-fallback",
            requestedEffort: "low",
            effectiveEffort: "low",
            inputDigest: leased.inputDigest,
            outputDigest: requireIntentDigest(output),
            configDigest: acceptanceFixtureProducer.permissionsDigest,
            startedAt: Date.now() - 5,
            completedAt: Date.now(),
            terminal: true,
            controllerCreated: true,
            unexpectedTools: 0,
            unexpectedChildren: 0,
          },
        }),
      ),
    ).rejects.toThrow("acceptance_result_provenance");
    expect(await db.deliveryAcceptancePlan.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("SQL preserves original intent and prevents a leased row inventing a native thread", async () => {
    const f = await acceptanceFixture(db);
    await expect(
      db.$executeRaw`UPDATE delivery_acceptance_intents SET intent_digest=${"e".repeat(64)} WHERE owner_id=${f.user.id}::uuid`,
    ).rejects.toThrow();
    const claim = await f.transaction((tx) => f.store.claim(tx, f.authority));
    if (claim.phase !== "leased") throw Error("fixture claim");
    await expect(
      db.$executeRaw`UPDATE delivery_acceptance_jobs SET evaluator_thread_id='forged' WHERE id=${claim.jobId}::uuid`,
    ).rejects.toThrow();
    const row = await db.deliveryAcceptanceJob.findUniqueOrThrow({ where: { id: claim.jobId } });
    expect(row.evaluatorThreadId).toBeNull();
  });
});
