import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { managerProofPayload } from "@/lib/delivery/manager-contracts";
import { DeliveryNativeSourceService } from "@/lib/delivery/native.server";
import { nativeProofPayload } from "@/lib/delivery/native-contracts";
import { nativeFixture } from "./native-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const started = (f: Awaited<ReturnType<typeof nativeFixture>>) => ({
  ...f.source,
  kind: "started",
  requestedModel: "gpt-6.1-sol",
  requestedEffort: "low",
  effectiveModel: "gpt-6.1-sol",
  effectiveEffort: "low",
});
describe.skipIf(!url)("trusted checkout and native-source PostgreSQL boundary", () => {
  it("maps distinct manager task/preparation IDs and atomically holds the exact native attempt", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const attempt = await f.claim();
    const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } }),
      binding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: attempt.managerBindingId },
      });
    expect(task.managerBindingId).toBe(binding.id);
    expect(task.id).not.toBe(binding.preparationIntentId);
    expect(binding.preparationIntentId).toBe(f.context.preparationIntentId);
    expect(binding.activeAttemptId).toBe(attempt.attemptId);
    expect(task.sourceSha).toBe(f.context.revision);
    await expect(
      db.deliveryManagerBinding.update({
        where: { id: binding.id },
        data: { sourceSha: "b".repeat(40) },
      }),
    ).rejects.toThrow("immutable");
  });
  it("rejects caller source overrides, mismatched persisted source and foreign preparation identity", async () => {
    const f = await nativeFixture(db),
      other = await nativeFixture(db);
    await expect(
      f.manager.execute(
        f.managerEnvelope({
          operation: "create_task",
          payload: { ...f.definition, sourceSha: f.context.revision },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.manager.execute(
        f.managerEnvelope(
          { operation: "create_task", payload: f.definition },
          { checkoutBinding: { ...f.context, revision: "b".repeat(40) } },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      f.manager.execute(
        f.managerEnvelope(
          { operation: "create_task", payload: f.definition },
          {
            checkoutBinding: {
              ...f.context,
              preparationIntentId: other.context.preparationIntentId,
            },
          },
        ),
      ),
    ).rejects.toThrow();
    expect(await db.deliveryTask.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("records actual-protocol start/command/turn facts but exit0 creates no acceptance evidence or quiescence", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const attempt = await f.claim();
    await f.native.ingest(f.sourceEnvelope(attempt, started(f), 1));
    const command = f.sourceEnvelope(
      attempt,
      {
        ...f.source,
        kind: "command_completed",
        itemId: "command",
        commandDigest: "b".repeat(64),
        outputDigest: "c".repeat(64),
        exitCode: 0,
        status: "completed",
      },
      2,
    );
    await f.native.ingest(command);
    expect(await f.native.ingest(command)).toMatchObject({
      accepted: true,
      replayed: true,
      sequence: 2,
    });
    await f.native.ingest(
      f.sourceEnvelope(attempt, { ...f.source, kind: "turn_completed", status: "completed" }, 3),
    );
    const row = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } });
    expect(row).toMatchObject({
      effectiveModel: "gpt-6.1-sol",
      effectiveEffort: "low",
      runtimeVersion: 3,
      quiescedAt: null,
    });
    expect(row.runtimeBinding).toMatchObject({
      nativeThreadId: f.source.childThreadId,
      nativeTurnId: f.source.childTurnId,
      operationId: f.source.spawnCallId,
      sourceSha: f.context.revision,
      coderOwnerId: f.user.coderUserId,
    });
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    await expect(
      db.deliveryManagerBinding.update({
        where: { id: attempt.managerBindingId },
        data: { activeAttemptId: null },
      }),
    ).rejects.toThrow("not confirmed quiescent");
  });
  it("rejects manager proof-domain, producer and test-pass assertions from the native source scope", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const attempt = await f.claim(),
      value = f.sourceEnvelope(attempt, started(f), 1);
    await expect(
      f.native.ingest({
        ...value,
        proof: sign(null, Buffer.from(managerProofPayload(value)), f.keys.privateKey).toString(
          "base64url",
        ),
      }),
    ).rejects.toThrow();
    await expect(f.native.ingest({ ...value, producer: "github-actions" })).rejects.toThrow();
    await expect(
      f.native.ingest(f.sourceEnvelope(attempt, { ...started(f), testStatus: "passed" }, 1)),
    ).rejects.toThrow();
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "native_runtime_started" },
      }),
    ).toBe(0);
  });
  it("gap and cross-owner frames cannot mutate another attempt; another parent turn is held for review", async () => {
    const f = await nativeFixture(db),
      other = await nativeFixture(db);
    await f.create();
    await other.create();
    const attempt = await f.claim(),
      foreign = await other.claim();
    await expect(f.native.ingest(f.sourceEnvelope(attempt, started(f), 2))).rejects.toThrow(
      "native_sequence_gap",
    );
    await expect(
      f.native.ingest(
        f.sourceEnvelope(attempt, started(f), 1, {
          taskId: other.taskId,
          stepId: other.stepId,
          attemptId: foreign.attemptId,
        }),
      ),
    ).rejects.toThrow();
    expect(
      await f.native.ingest(
        f.sourceEnvelope(attempt, { ...started(f), parentTurnId: randomUUID() }, 1),
      ),
    ).toMatchObject({ accepted: true, blocked: true });
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: attempt.managerBindingId },
        })
      ).blockedReason,
    ).toBe("native_parent_turn_mismatch");
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: foreign.attemptId } }))
        .runtimeVersion,
    ).toBe(0);
  });
  it("same-event source contradiction blocks the binding and preserves the original native identity", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const attempt = await f.claim(),
      value = f.sourceEnvelope(attempt, started(f), 1);
    await f.native.ingest(value);
    const changed = {
      ...value,
      source: { ...(value.source as Record<string, unknown>), effectiveModel: "unapproved" },
    };
    const signed = {
      ...changed,
      proof: sign(null, Buffer.from(nativeProofPayload(changed)), f.keys.privateKey).toString(
        "base64url",
      ),
    };
    expect(await f.native.ingest(signed)).toMatchObject({ accepted: false, blocked: true });
    expect(await f.native.ingest(signed)).toMatchObject({ replayed: true, blocked: true });
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } }))
        .effectiveModel,
    ).toBe("gpt-6.1-sol");
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(1);
  });
  it("one checkout cannot reserve another manager task while any native writer remains unconfirmed", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const first = await f.claim();
    const task = randomUUID(),
      step = randomUUID();
    await f.create({ ...f.definition, id: task, steps: [{ ...f.definition.steps[0], id: step }] });
    await expect(f.claim(task, step)).rejects.toThrow("checkout_writer_busy");
    await f.native.ingest(f.sourceEnvelope(first, started(f), 1));
    await f.native.ingest(
      f.sourceEnvelope(first, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
    );
    await expect(f.claim(task, step)).rejects.toThrow("checkout_writer_busy");
  });
  it("same native lifetime registration reissue preserves the stable checkout binding and source replay", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const attempt = await f.claim();
    await f.native.ingest(f.sourceEnvelope(attempt, started(f), 1));
    await f.register();
    expect(
      await f.native.ingest(
        f.sourceEnvelope(attempt, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
      ),
    ).toMatchObject({ accepted: true, sequence: 2 });
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: attempt.managerBindingId },
        })
      ).activeAttemptId,
    ).toBe(attempt.attemptId);
  });
  it("revocation after fresh Coder authorization prevents native-source writes", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const attempt = await f.claim();
    const native = new DeliveryNativeSourceService(db, {
      ...f.dependencies,
      reauthorize: async (binding) => {
        await db.codexHostRegistration.update({
          where: { id: f.registration().id },
          data: { revokedAt: new Date() },
        });
        return binding;
      },
    });
    await expect(native.ingest(f.sourceEnvelope(attempt, started(f), 1))).rejects.toThrow();
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } }))
        .runtimeVersion,
    ).toBe(0);
  });
  it("late native start is recorded as held failure instead of authorizing an expired attempt", async () => {
    const f = await nativeFixture(db);
    await f.create();
    const attempt = await f.claim();
    await db.deliveryAttempt.update({
      where: { id: attempt.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    expect(await f.native.ingest(f.sourceEnvelope(attempt, started(f), 1))).toMatchObject({
      accepted: true,
      blocked: true,
      activeAttemptHeld: true,
    });
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
  });
});
