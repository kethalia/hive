import { randomUUID, verify } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { accountMaintenanceGrantSchema } from "@/lib/codex-session/account-maintenance-contracts";
import { AccountMaintenanceStore } from "@/lib/codex-session/account-maintenance-store.server";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import type {
  RegistrationBinding,
  VerifiedHostBinding,
} from "@/lib/codex-session/registration.server";
import { resumeAccountMaintenanceFixture } from "./account-maintenance-fixture";
import { guardianFixture } from "./guardian-fixture";

const url = process.env.HIVE_ACCOUNT_MAINTENANCE_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(u.hostname) ||
    u.pathname !== "/hive_account_maintenance_test"
  )
    throw Error("Owned local fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_account_maintenance_test",
});
afterAll(() => db.$disconnect());

describe.skipIf(!url)("maintenance persisted command delivery, actual PostgreSQL", () => {
  it.each([
    false,
    true,
  ])("recovers pause/resume transport loss with original identities (lost accepted resume ACK: %s)", async (loseAck) => {
    const fixture = await guardianFixture(db);
    await fixture.create();
    await fixture.claim();
    const binding = fixture.guardian.runtime.binding as unknown as RegistrationBinding;
    const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: fixture.guardian.runtime.id },
    });
    const store = new AccountMaintenanceStore(db);
    const input = {
      requestId: randomUUID(),
      expectedVersion: 0,
      runtimeId: runtime.id,
      runtimeGeneration: runtime.generation,
    };
    const principal = { hiveUserId: binding.hiveUserId, coderUserId: binding.ownerId };
    const originalAttempts = await db.deliveryAttempt.findMany({
      where: { ownerId: binding.hiveUserId },
    });
    type Claims = ReturnType<typeof accountMaintenanceGrantSchema.parse>;
    const delivered: Claims[] = [];
    let unavailable = true,
      unknownPauseAck = true,
      resumeAccepted = false,
      registrationUnavailable = true,
      archives: unknown;
    const applications = { pause: 0, resume: 0 };
    const pauses = new Set<string>();
    const register = vi.fn(
        async (
          _binding: VerifiedHostBinding,
          _projects: Array<{ projectId: string; preparationIntentId: string; requestId: string }>,
        ) => {
          if (registrationUnavailable) throw Error("registration response unavailable");
        },
      ),
      idle = vi.fn(async () => {});
    const service = new GuardianService(
      db,
      fixture.guardian.sessionConfig,
      fixture.guardian.policy,
      "19".repeat(32),
      {
        env: { HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED: "true" },
        async resolveWorkspace(p, w) {
          if (
            p.hiveUserId !== principal.hiveUserId ||
            p.coderUserId !== principal.coderUserId ||
            w !== binding.workspaceId
          )
            throw Error("wrong owner/workspace");
          return binding as unknown as VerifiedHostBinding;
        },
        assertMaintenanceAccountsIdle: idle,
        registerMaintenanceHost: register,
        transport: {
          async identity() {
            throw Error("must not enroll");
          },
          async bootstrap() {
            throw Error("must not bootstrap");
          },
          async accountMaintenance(_, token) {
            const [head, body, signature] = token.split(".");
            expect(
              verify(
                null,
                Buffer.from(`${head}.${body}`),
                fixture.guardian.issuer.publicKey,
                Buffer.from(signature, "base64url"),
              ),
            ).toBe(true);
            const c = accountMaintenanceGrantSchema.parse(
              JSON.parse(Buffer.from(body, "base64url").toString()),
            );
            delivered.push(c);
            if (c.action === "inspect-resume") return archives;
            if (unavailable) throw Error("transport dropped before receive");
            if (c.action === "pause") {
              if (!pauses.has(c.jti)) {
                pauses.add(c.jti);
                applications.pause++;
              }
              return unknownPauseAck ? { accepted: "unknown" } : { accepted: true };
            }
            // An accepted host resume is not a second launch capability. A lost
            // response or subsequent duplicate still leaves factual DB readback.
            if (resumeAccepted) throw Error("account_maintenance_resume_unavailable");
            resumeAccepted = true;
            applications.resume++;
            if (loseAck) throw Error("accepted response lost");
            return { accepted: true };
          },
        },
      },
    );
    const status = () =>
      service.accountMaintenance(principal, binding.workspaceId, { action: "status" });
    await expect(
      service.accountMaintenance(principal, binding.workspaceId, {
        action: "request",
        confirmed: true,
        ...input,
      }),
    ).rejects.toThrow();
    expect((await store.status(binding)).state).toBe("requested");
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: fixture.taskId } })).pauseRequested,
    ).toBe(true);
    expect(await status()).toMatchObject({ state: "requested", maintenanceId: input.requestId });
    unavailable = false;
    expect(await status()).toMatchObject({ state: "requested", maintenanceId: input.requestId });
    unknownPauseAck = false;
    expect(await status()).toMatchObject({ state: "requested", maintenanceId: input.requestId });
    expect(applications.pause).toBe(1);
    expect(new Set(delivered.map((c) => c.jti))).toEqual(new Set([input.requestId]));
    const pauseCalls = delivered.length;
    let resumeInput:
      | { requestId: string; expectedVersion: number; maintenanceId: string }
      | undefined;
    const result = await resumeAccountMaintenanceFixture(
      db,
      { fixture, binding, runtime, store, input },
      true,
      {
        beforeResume: async (context) => {
          archives = context.archive;
          resumeInput = context.input;
          expect(await status()).toMatchObject({ state: "ready" });
          expect(delivered).toHaveLength(pauseCalls); // closed old tree: never resend pause
          unavailable = true;
          await expect(
            service.accountMaintenance(principal, binding.workspaceId, {
              action: "resume",
              confirmed: true,
              ...context.input,
            }),
          ).rejects.toThrow();
          const receipts = await db.codexGuardianOperationReceipt.findMany({
            where: { ownerId: principal.hiveUserId, action: "maintenance_resume_intent" },
          });
          expect(receipts).toHaveLength(1);
          expect(await status()).toMatchObject({ state: "resuming" }); // transport still unavailable
          unavailable = false;
          registrationUnavailable = false;
          expect(await status()).toMatchObject({ state: "resuming" }); // accepted or lost ACK
          expect(await status()).toMatchObject({ state: "resuming" }); // duplicate: hold/readback, no repeat launch
          expect(applications.resume).toBe(1);
          const resumes = delivered.filter((c) => c.action === "resume");
          expect(new Set(resumes.map((c) => c.jti))).toEqual(new Set([context.input.requestId]));
          expect(new Set(resumes.map((c) => c.ownerIntentRuntimeId))).toEqual(
            new Set([receipts[0].runtimeId]),
          );
          expect(new Set(resumes.map((c) => c.ownerIntentEventId))).toEqual(
            new Set([receipts[0].eventId]),
          );
          expect(
            await db.codexGuardianOperationReceipt.findMany({
              where: { ownerId: principal.hiveUserId, action: "maintenance_resume_intent" },
            }),
          ).toEqual(receipts);
          expect(idle).toHaveBeenCalledTimes(1);
          expect(register).toHaveBeenCalled();
          for (const call of register.mock.calls)
            expect(call[1]).toEqual(
              (receipts[0].response as { maintenance: { projects: unknown } }).maintenance.projects,
            );
        },
        beforeFinalize: async () => {
          const count = delivered.length;
          expect(await status()).toMatchObject({ state: "resuming" });
          expect(delivered).toHaveLength(count); // actual prepare/native generation has advanced
        },
      },
    );
    const count = delivered.length;
    expect(await status()).toMatchObject({ state: "finished" });
    expect(
      await service.accountMaintenance(principal, binding.workspaceId, {
        action: "resume",
        confirmed: true,
        ...resumeInput!,
      }),
    ).toMatchObject({ state: "finished" });
    expect(delivered).toHaveLength(count);
    expect(await db.deliveryAttempt.findMany({ where: { ownerId: principal.hiveUserId } })).toEqual(
      originalAttempts,
    );
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: principal.hiveUserId, type: "account_maintenance_epoch_committed" },
      }),
    ).toBe(1);
    const fresh = await db.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: result.idle.id },
    });
    const nextId = randomUUID();
    await store.request(binding, {
      requestId: nextId,
      expectedVersion: (await store.status(binding)).version,
      runtimeId: fresh.id,
      runtimeGeneration: fresh.generation,
    });
    await expect(
      service.accountMaintenance(principal, binding.workspaceId, {
        action: "resume",
        confirmed: true,
        ...resumeInput!,
      }),
    ).rejects.toThrow();
    expect(delivered).toHaveLength(count);
    expect(await status()).toMatchObject({ state: "requested", maintenanceId: nextId });
    expect(delivered.at(-1)).toMatchObject({ action: "pause", jti: nextId, maintenanceId: nextId });
    await expect(
      service.accountMaintenance({ ...principal, hiveUserId: randomUUID() }, binding.workspaceId, {
        action: "status",
      }),
    ).rejects.toThrow();
  });
});
