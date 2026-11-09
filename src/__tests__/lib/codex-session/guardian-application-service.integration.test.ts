import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { guardianApplicationAuthoritySchema } from "@/lib/codex-session/guardian-application-contracts";
import { guardianPost } from "@/lib/codex-session/guardian-route.server";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import {
  guardianTransportEnvelopeSchema,
  guardianTransportProofPayload,
} from "@/lib/codex-session/guardian-transport-contracts";
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
async function fixture(signal?: AbortSignal) {
  const f = await guardianApplicationFixture(db, (policy) => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
    vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
    vi.stubEnv(
      "HIVE_GUARDIAN_APPROVED_PACKAGES_JSON",
      JSON.stringify((policy as { packages: unknown }).packages),
    );
  });
  const { projects: _projects, ...binding } = f.host;
  const env: Record<string, string | undefined> = {
    HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
    HIVE_CODEX_MANAGER_EFFORT: "low",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED: "true",
  };
  let resolutions = 0,
    resolveHook: (() => Promise<void>) | undefined;
  const service = new GuardianService(
    db,
    f.guardian.sessionConfig,
    f.guardian.policy,
    "19".repeat(32),
    {
      env,
      signal,
      async resolveWorkspace(principal, workspaceId) {
        resolutions++;
        expect(principal).toEqual({ hiveUserId: f.user.id, coderUserId: f.user.coderUserId });
        expect(workspaceId).toBe(f.host.workspaceId);
        await resolveHook?.();
        return binding;
      },
    },
  );
  const frame = (action: string, fields: Record<string, unknown>) => {
    const parsed = guardianTransportEnvelopeSchema.parse({
      schemaVersion: 1,
      action,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: f.guardian.finalized.runtime.generation,
      eventId: randomUUID(),
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
      ...fields,
      proof: "A".repeat(86),
    });
    return {
      ...parsed,
      proof: sign(
        null,
        Buffer.from(guardianTransportProofPayload(parsed)),
        f.guardian.outer.privateKey,
      ).toString("base64url"),
    };
  };
  return {
    ...f,
    service,
    env,
    frame,
    resolutions: () => resolutions,
    setResolveHook: (hook: () => Promise<void>) => {
      resolveHook = hook;
    },
  };
}
describe.skipIf(!url)(
  "signed application actions use approved outer/current PostgreSQL scope",
  () => {
    it("crosses signed fixed route and strict positive schema through reserve/verify/protected commit", async () => {
      const f = await fixture(),
        input = f.reservation();
      const response = await guardianPost(
        new Request("https://hive.invalid/api/codex-host/guardians", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(f.frame("apply_reserve", input)),
        }),
        () => f.service,
      );
      expect(response.status).toBe(200);
      const reserved = guardianApplicationAuthoritySchema.parse(await response.json());
      expect(reserved.phase).toBe("pending");
      expect(reserved.inputBarrier.id).toBe(input.inputBarrier.id);
      const verified = guardianApplicationAuthoritySchema.parse(
        await f.service.execute(
          f.frame("apply_verify", {
            projectId: f.project.id,
            applicationId: input.applicationId,
          }),
        ),
      );
      expect(verified.producer.metadataPinsDigest).toBe(
        f.guardian.finalized.admission.metadataPinsDigest,
      );
      const committed = guardianApplicationAuthoritySchema.parse(
        await f.service.execute(
          f.frame("apply_commit", {
            projectId: f.project.id,
            applicationId: input.applicationId,
            appliedReceipt: f.receipt(input),
          }),
        ),
      );
      expect(committed.phase).toBe("applied");
      expect(committed.executionAuthorized).toBe(false);
      expect(committed.cleanupAuthorized).toBe(false);
    });
    it("new actions default off and forged outer proofs fail before Coder resolution", async () => {
      const f = await fixture(),
        input = f.reservation(),
        request = f.frame("apply_reserve", input);
      f.env.HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED = undefined;
      await expect(f.service.execute(request)).rejects.toBeInstanceOf(RegistrationRejected);
      expect(f.resolutions()).toBe(0);
      f.env.HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED = "true";
      await expect(f.service.execute({ ...request, proof: "A".repeat(86) })).rejects.toBeInstanceOf(
        RegistrationRejected,
      );
      expect(f.resolutions()).toBe(0);
      expect(await db.deliverySourceApplication.count({ where: { ownerId: f.user.id } })).toBe(0);
    });
    it("foreign application/project and extra policy fields cannot select source or execution authority", async () => {
      const f = await fixture(),
        input = f.reservation();
      await f.service.execute(f.frame("apply_reserve", input));
      await expect(
        f.service.execute(
          f.frame("apply_verify", { projectId: randomUUID(), applicationId: input.applicationId }),
        ),
      ).rejects.toBeInstanceOf(RegistrationRejected);
      await expect(
        f.service.execute({
          ...f.frame("apply_verify", {
            projectId: f.project.id,
            applicationId: input.applicationId,
          }),
          executionAuthorized: true,
        }),
      ).rejects.toThrow();
      const row = await db.deliverySourceApplication.findUniqueOrThrow({
        where: { id: input.applicationId },
      });
      expect(row.phase).toBe("pending");
    });
  },
);

it.skipIf(!url)(
  "signed application lifetime expires during observed SQL commit write and rolls back acknowledgement",
  async () => {
    const f = await fixture(),
      input = f.reservation();
    await f.service.execute(f.frame("apply_reserve", input));
    const name = `app_delay_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('application_name','${name}',true); PERFORM pg_sleep(1.3); RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON delivery_source_applications FOR EACH ROW WHEN(NEW.id='${input.applicationId}'::uuid AND NEW.phase='applied') EXECUTE FUNCTION ${name}()`,
    );
    try {
      const request = f.frame("apply_commit", {
        projectId: f.project.id,
        applicationId: input.applicationId,
        appliedReceipt: f.receipt(input),
        expiresAt: Date.now() + 1000,
      });
      const pending = f.service.execute(request);
      void pending.catch(() => {});
      let observed = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${name} AND wait_event='PgSleep'`;
        if (rows[0].n === 1) {
          observed = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(observed).toBe(true);
      expect(Date.now()).toBeLessThan(request.expiresAt);
      await expect(pending).rejects.toBeInstanceOf(RegistrationRejected);
      expect(
        (
          await db.deliverySourceApplication.findUniqueOrThrow({
            where: { id: input.applicationId },
          })
        ).phase,
      ).toBe("pending");
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON delivery_source_applications`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
  },
);

it.skipIf(!url)(
  "signed stale generations cannot reserve, verify or commit current application authority",
  async () => {
    const f = await fixture(),
      input = f.reservation(),
      stale = f.guardian.finalized.runtime.generation - 1;
    await expect(
      f.service.execute(f.frame("apply_reserve", { ...input, runtimeGeneration: stale })),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    expect(await db.deliverySourceApplication.count({ where: { ownerId: f.user.id } })).toBe(0);
    await f.service.execute(f.frame("apply_reserve", input));
    await expect(
      f.service.execute(
        f.frame("apply_verify", {
          projectId: f.project.id,
          applicationId: input.applicationId,
          runtimeGeneration: stale,
        }),
      ),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    await expect(
      f.service.execute(
        f.frame("apply_commit", {
          projectId: f.project.id,
          applicationId: input.applicationId,
          appliedReceipt: f.receipt(input),
          runtimeGeneration: stale,
        }),
      ),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    expect(
      (await db.deliverySourceApplication.findUniqueOrThrow({ where: { id: input.applicationId } }))
        .phase,
    ).toBe("pending");
  },
);
it.skipIf(!url)(
  "concurrent persisted generation change after signed authentication cannot upgrade an old generation",
  async () => {
    const f = await fixture(),
      input = f.reservation();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((done) => {
        entered = done;
      }),
      wait = new Promise<void>((done) => {
        release = done;
      });
    f.setResolveHook(async () => {
      entered();
      await wait;
    });
    const pending = f.service.execute(f.frame("apply_reserve", input));
    void pending.catch(() => {});
    await reached;
    try {
      // The native launch intentionally forbids adding preparation inventory.
      // Inject only its monotonic persisted generation transition to isolate the
      // signed-read/transaction-lock race without inventing a new admission API.
      const bumped = await db.codexGuardianRuntime.update({
        where: { id: f.guardian.runtime.id },
        data: { generation: { increment: 1 } },
      });
      expect(bumped.generation).toBe(f.guardian.finalized.runtime.generation + 1);
    } finally {
      release();
    }
    await expect(pending).rejects.toBeInstanceOf(RegistrationRejected);
    expect(await db.deliverySourceApplication.count({ where: { ownerId: f.user.id } })).toBe(0);
  },
);

it.skipIf(!url)(
  "abort during observed signed application write rolls back the pending reservation",
  async () => {
    const abort = new AbortController(),
      f = await fixture(abort.signal),
      input = f.reservation();
    await f.service.execute(f.frame("apply_reserve", input));
    const name = `app_abort_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('application_name','${name}',true); PERFORM pg_sleep(1.3); RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON delivery_source_applications FOR EACH ROW WHEN(NEW.id='${input.applicationId}'::uuid AND NEW.phase='applied') EXECUTE FUNCTION ${name}()`,
    );
    try {
      const pending = f.service.execute(
        f.frame("apply_commit", {
          projectId: f.project.id,
          applicationId: input.applicationId,
          appliedReceipt: f.receipt(input),
        }),
      );
      void pending.catch(() => {});
      let observed = false;
      for (let i = 0; i < 200; i++) {
        const rows = await db.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${name} AND wait_event='PgSleep'`;
        if (rows[0].n === 1) {
          observed = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(observed).toBe(true);
      abort.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(
        (
          await db.deliverySourceApplication.findUniqueOrThrow({
            where: { id: input.applicationId },
          })
        ).phase,
      ).toBe("pending");
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON delivery_source_applications`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
  },
);
