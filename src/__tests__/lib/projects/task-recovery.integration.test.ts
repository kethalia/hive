import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import { ProjectTaskIntents } from "@/lib/projects/task-intents.server";
import { ProjectTaskRecoveries } from "@/lib/projects/task-recovery-store.server";
import { projectRecovery } from "../../../../templates/ai-dev-k8s/scripts/codex-project-recovery.mjs";
import { guardianFixture } from "../codex-session/guardian-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw Error("Isolated fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
async function fixture(absent = false) {
  const f = await guardianFixture(db),
    intents = new ProjectTaskIntents(db, "19".repeat(32)),
    recoveries = new ProjectTaskRecoveries(db, intents);
  let taskId = f.context.preparationIntentId;
  if (absent) {
    const original = intents.payload(
      await db.projectTaskIntent.findUniqueOrThrow({ where: { id: taskId } }),
    );
    f.project = await db.deliveryProject.create({
      data: {
        ownerId: f.user.id,
        provider: "github",
        providerRepositoryId: "789",
        providerAccountId: "456",
        fullName: "fixture/absent",
      },
    });
    taskId = randomUUID();
    const requestId = randomUUID();
    await intents.enqueue({
      ...original,
      projectId: f.project.id,
      taskId,
      requestId,
      requestDigest: guardianDigest(randomUUID()),
      hostRequest: {
        ...original.hostRequest,
        projectId: f.project.id,
        repositoryId: "789",
        taskId,
        requestId,
      },
    });
  }
  await db.projectTaskIntent.update({
    where: { id: taskId },
    data: {
      phase: "blocked",
      status: {
        schemaVersion: 1,
        projectId: f.project.id,
        taskId,
        phase: "blocked",
        reason: "native_unavailable",
        nativeThreadId: null,
        terminalSessionName: null,
      },
    },
  });
  const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
    where: { id: f.guardian.runtime.id },
  });
  const input = {
    ownerId: f.user.id,
    coderOwnerId: f.user.coderUserId,
    projectId: f.project.id,
    taskId,
    workspaceId: f.host.workspaceId,
    recoveryId: randomUUID(),
  };
  const begin = async () => {
    const r = await recoveries.begin(input);
    if (!r) throw Error("fixture missing attempt");
    return r;
  };
  const inspection = {
    outcome: "existing_preexecution" as const,
    taskFingerprint: "f".repeat(64),
    buildId: runtime.buildId,
    lifetimeId: runtime.lifetimeId,
    guardianGeneration: runtime.generation,
  };
  const fence = (recovery?: { recoveryId: string; authorizationDigest: string }) =>
    new GuardianAdmissionStore(db, {
      policy: f.guardian.policy,
      encryptionKey: "19".repeat(32),
      expectedConfigSha256: f.guardian.expectedConfigSha256,
      operation: {
        ownerId: f.user.id,
        runtimeId: runtime.id,
        eventId: randomUUID(),
        action: "fence",
        inputRuntimeGeneration: runtime.generation,
        requestDigest: guardianDigest(randomUUID()),
        projectId: f.project.id,
        recovery,
      },
    }).fence({
      ownerId: f.user.id,
      runtimeId: runtime.id,
      runtimeGeneration: runtime.generation,
      projectId: f.project.id,
      preparationDigest: f.guardian.prepared.admission.preparationDigest,
    });
  return { ...f, intents, recoveries, runtime, input, begin, inspection, fence };
}
describe.skipIf(!url)("owner recovery with actual PostgreSQL and canonical host consume", () => {
  it("restores absent task QUEUED with identical encrypted prompt, excluding claims until local receipt", async () => {
    const f = await fixture(true),
      before = await f.intents.get(f.user.id, f.project.id, f.input.taskId, f.host.workspaceId),
      r = await f.begin();
    const a = await f.recoveries.authorize(
      r,
      { ...f.inspection, outcome: "task_absent" },
      f.runtime,
      async () => {},
    );
    const held = await f.intents.get(f.user.id, f.project.id, f.input.taskId, f.host.workspaceId);
    expect(held.phase).toBe("queued");
    expect(held.ciphertext).toEqual(before.ciphertext);
    expect(held.iv).toEqual(before.iv);
    expect(held.authTag).toEqual(before.authTag);
    expect(await f.intents.claim({ ownerId: f.user.id, taskId: f.input.taskId })).toBeNull();
    expect(JSON.stringify(a)).not.toContain(f.intents.payload(before).hostRequest.text);
    const receipt = {
      schemaVersion: 1,
      recoveryId: r.id,
      scopeDigest: guardianDigest(r.scope),
      inspectionDigest: a.authorization!.inspectionDigest,
      authorizationDigest: guardianDigest(a.authorization),
      outcome: "task_absent",
      buildId: f.runtime.buildId,
      lifetimeId: f.runtime.lifetimeId,
    };
    await f.recoveries.finish(a, receipt);
    await f.recoveries.finish(a, receipt);
    const claimed = await f.intents.claim({ ownerId: f.user.id, taskId: f.input.taskId });
    expect(claimed).not.toBeNull();
    expect(f.intents.execution(claimed!).hostRequest).toEqual(
      f.intents.payload(before).hostRequest,
    );
  });
  it("canonical host holds through CAS and real fresh fence, then lost consume ACK/restart replays receipt without rescheduling", async () => {
    const f = await fixture(),
      r = await f.begin();
    let p: Record<string, any> = {
      projectId: f.project.id,
      repositoryId: r.scope.repositoryId,
      expectedAccountId: r.scope.providerAccountId,
      task: {
        taskId: f.input.taskId,
        request: f.intents.payload(
          await f.intents.get(f.user.id, f.project.id, f.input.taskId, f.host.workspaceId),
        ).hostRequest,
        digest: r.scope.hostRequestDigest,
        phase: "blocked",
        reason: "native_unavailable",
        prepared: {},
      },
    };
    let saved: typeof p,
      scheduled = 0,
      fences = 0;
    const local = () =>
      projectRecovery({
        config: { ownerId: f.user.coderUserId, workspaceId: f.host.workspaceId },
        buildId: f.runtime.buildId,
        guardian: {
          state: {
            phase: "open",
            lifetimeId: f.runtime.lifetimeId,
            generation: f.runtime.generation,
          },
          identity: async (nonce: string) => ({
            nonce,
            identity: { lifetimeId: f.runtime.lifetimeId },
            startup: { generation: f.runtime.generation },
          }),
        },
        save() {
          saved = structuredClone(p);
        },
        taskDigest: () => r.scope.hostRequestDigest,
        prove: async () => {},
        absent: async () => {
          throw Error("wrong outcome");
        },
        fence: async () => {
          fences++;
          expect(saved.recovery.phase).toBe("consuming");
          await f.fence({
            recoveryId: r.id,
            authorizationDigest: guardianDigest(p.recovery.authorization),
          });
        },
        schedule() {
          expect(saved.recovery.phase).toBe("consumed");
          scheduled++;
        },
      });
    let host = local();
    const inspected = await host("/projects/tasks/recovery-inspect", p, {
      schemaVersion: 1,
      scope: r.scope,
    });
    await expect(f.fence()).rejects.toThrow();
    const a = await f.recoveries.authorize(r, inspected.inspection, f.runtime, async () => {});
    expect(await f.intents.claim({ ownerId: f.user.id, taskId: f.input.taskId })).toBeNull();
    const request = { schemaVersion: 1, scope: r.scope, authorization: a.authorization };
    const receipt = await host("/projects/tasks/recovery-consume", p, request);
    expect(scheduled).toBe(1);
    expect(fences).toBe(1);
    p = structuredClone(saved!);
    host = local();
    expect(await host("/projects/tasks/recovery-consume", p, request)).toEqual(receipt);
    expect(scheduled).toBe(1);
    expect(fences).toBe(1);
    await f.recoveries.finish(a, receipt);
    await f.fence();
  });
  it("rejects inspection version race and rolls policy failure back before authorization", async () => {
    const f = await fixture(),
      r = await f.begin();
    await expect(
      f.recoveries.authorize(
        r,
        { ...f.inspection, outcome: "task_absent" },
        f.runtime,
        async () => {},
      ),
    ).rejects.toThrow();
    await expect(
      f.recoveries.authorize(r, f.inspection, f.runtime, async () => {
        throw Error("policy revoked");
      }),
    ).rejects.toThrow("policy revoked");
    expect((await f.begin()).phase).toBe("inspecting");
    expect(
      (await f.intents.get(f.user.id, f.project.id, f.input.taskId, f.host.workspaceId)).phase,
    ).toBe("blocked");
    await db.projectTaskIntent.update({ where: { id: f.input.taskId }, data: { failureCount: 4 } });
    await expect(
      f.recoveries.authorize(r, f.inspection, f.runtime, async () => {}),
    ).rejects.toThrow("retry_not_available");
  });
  it("fresh fence rejects ordinary request, substituted grant, cancellation and expired authorization", async () => {
    const f = await fixture(),
      r = await f.begin(),
      a = await f.recoveries.authorize(r, f.inspection, f.runtime, async () => {});
    await expect(f.fence()).rejects.toThrow();
    await expect(
      f.fence({ recoveryId: r.id, authorizationDigest: "0".repeat(64) }),
    ).rejects.toThrow();
    const proof = { recoveryId: r.id, authorizationDigest: guardianDigest(a.authorization) };
    await f.fence(proof);
    await db.projectTaskIntent.update({
      where: { id: f.input.taskId },
      data: { phase: "blocked" },
    });
    await expect(f.fence(proof)).rejects.toThrow();
    const expired = await fixture(),
      er = await expired.begin();
    await db.codexGuardianRuntime.update({
      where: { id: expired.runtime.id },
      data: { authorityUntil: new Date(Date.now() - 1) },
    });
    await expect(
      expired.recoveries.authorize(er, expired.inspection, expired.runtime, async () => {}),
    ).rejects.toThrow();
  });
  it("reuses active attempt, and database rejects immutable scope changes/deletion", async () => {
    const f = await fixture(),
      r = await f.begin();
    expect((await f.recoveries.begin({ ...f.input, recoveryId: randomUUID() }))?.id).toBe(r.id);
    await expect(
      db.$executeRaw`UPDATE project_task_recoveries SET scope='{}'::jsonb WHERE owner_id=${f.user.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM project_task_recoveries WHERE owner_id=${f.user.id}::uuid`,
    ).rejects.toThrow();
  });
});

describe.skipIf(!url)("owner recovery commit deadline", () => {
  it("rolls back a fresh fence whose SQL effect completes after authorization expiry", async () => {
    const f = await fixture(),
      r = await f.begin();
    await db.codexGuardianRuntime.update({
      where: { id: f.runtime.id },
      data: { authorityUntil: new Date(Date.now() + 1800) },
    });
    const a = await f.recoveries.authorize(r, f.inspection, f.runtime, async () => {});
    const before = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtime.id } });
    const name = `recovery_delay_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.runtime.id}'::uuid THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      await expect(
        f.fence({ recoveryId: r.id, authorizationDigest: guardianDigest(a.authorization) }),
      ).rejects.toThrow();
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtime.id } }))
          .authorityUntil,
      ).toEqual(before.authorityUntil);
      expect(
        await db.codexGuardianOperationReceipt.count({ where: { runtimeId: f.runtime.id } }),
      ).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON codex_guardian_runtimes`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
  });
});
