import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  GUARDIAN_METADATA_POLICY_DIGEST,
  type GuardianPackagePin,
  type GuardianPolicy,
  guardianDigest,
} from "@/lib/codex-session/guardian-contracts";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import {
  type GuardianIdentityResponse,
  guardianIdentityProofPayload,
  guardianTransportProofPayload,
} from "@/lib/codex-session/guardian-transport-contracts";
import type { VerifiedHostBinding } from "@/lib/codex-session/registration.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { guardianFixture } from "./guardian-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(u.hostname) || u.pathname !== "/hive_delivery_test")
    throw new Error("Isolated fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture(
  patch?: (packet: GuardianIdentityResponse) => void,
  transformGrant?: (grant: string, service: GuardianService, key: KeyObject) => Promise<string>,
) {
  const issuer = generateKeyPairSync("ed25519"),
    outer = generateKeyPairSync("ed25519");
  const user = await db.user.create({
    data: {
      coderUrl: "https://guardian-coder.invalid",
      coderUserId: randomUUID(),
      username: "guardian-service-fixture",
      email: "fixture@invalid",
    },
  });
  const binding: VerifiedHostBinding = {
    coderOrigin: user.coderUrl,
    hiveUserId: user.id,
    ownerId: user.coderUserId,
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    buildId: randomUUID(),
    templateId: randomUUID(),
    appOrigin: "https://guardian-app.invalid",
    appId: randomUUID(),
  };
  const config = {
    privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId: "guardian-fixture",
    hiveOrigin: "https://hive.invalid",
    softwareTemplateIds: [binding.templateId],
    appSlug: "codex-session",
    gatewayPort: 13341,
    cookieDomains: [],
  };
  const env = {
    HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
    HIVE_CODEX_MANAGER_EFFORT: "low",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
  };
  const pin: GuardianPackagePin = {
    packageManifestSha256: "1".repeat(64),
    guardianElfSha256: "2".repeat(64),
    nodeSha256: "3".repeat(64),
    protocol: "guardian-v1" as const,
    policyDigest: "4".repeat(64),
    metadataPolicyDigest: GUARDIAN_METADATA_POLICY_DIGEST,
  };
  const policy: GuardianPolicy = { enabled: true, producerEnabled: true, packages: [pin] };
  const configSha256 = guardianConfigSha256(
    expectedGuardianHostConfig({ ...binding, projects: [] }, config, env),
  );
  const identity = {
    lifetimeId: randomUUID(),
    bindingDigest: sha(
      JSON.stringify({
        schemaVersion: 1,
        configSha256,
        packageManifestSha256: pin.packageManifestSha256,
      }),
    ),
    outerPublicKeyPem: outer.publicKey.export({ type: "spki", format: "pem" }).toString(),
    packageManifestSha256: pin.packageManifestSha256,
    guardianElfSha256: pin.guardianElfSha256,
    nodeSha256: pin.nodeSha256,
    policyDigest: pin.policyDigest,
    metadataPolicyDigest: pin.metadataPolicyDigest,
    configSha256,
  };
  const bootId = randomUUID(),
    kernel = { startTime: "100", bootId, executable: "/usr/bin/node", device: "123", inode: "456" };
  let service: GuardianService,
    grant = "",
    enrollment: unknown,
    runtimeId = "",
    resolutions = 0;
  const principal = { hiveUserId: user.id, coderUserId: user.coderUserId };
  const signFrame = (body: Record<string, unknown>, privateKey = outer.privateKey) => ({
    ...body,
    proof: sign(
      null,
      Buffer.from(guardianTransportProofPayload(body as never)),
      privateKey,
    ).toString("base64url"),
  });
  service = new GuardianService(db, config, policy, "19".repeat(32), {
    env,
    resolveWorkspace: async (p) => {
      resolutions++;
      expect(p).toEqual(principal);
      return structuredClone(binding);
    },
    transport: {
      async identity(b, nonce) {
        expect(b).toEqual(binding);
        const packet: GuardianIdentityResponse = {
          schemaVersion: 1,
          nonce,
          issuedAt: Date.now() - 100,
          expiresAt: Date.now() + 30000,
          identity,
          startup: {
            schemaVersion: 1,
            type: "ready",
            phase: "open",
            nonce: Buffer.alloc(32).toString("base64url"),
            configSha256,
            packageManifestSha256: pin.packageManifestSha256,
            nodeSha256: pin.nodeSha256,
            workerSha256: "a".repeat(64),
            guardianSha256: pin.guardianElfSha256,
            port: 13341,
            lifetimeId: identity.lifetimeId,
            bindingDigest: identity.bindingDigest,
            generation: 1,
            ownershipDigest: "b".repeat(64),
            projects: [],
            outerIdentity: { ...kernel, pid: 100, parentPid: 99 },
            guardianIdentity: {
              ...kernel,
              pid: 101,
              parentPid: 100,
              executable: "/package/codex-native-guardian",
              inode: "457",
            },
            workerIdentity: { ...kernel, pid: 102, parentPid: 101 },
          },
          proof: "A".repeat(86),
        };
        patch?.(packet);
        packet.proof = sign(
          null,
          Buffer.from(guardianIdentityProofPayload(packet)),
          outer.privateKey,
        ).toString("base64url");
        return packet;
      },
      async bootstrap(_binding, value) {
        if (transformGrant) value = await transformGrant(value, service, issuer.privateKey);
        grant = value;
        const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
        runtimeId = claims.runtimeId;
        enrollment = signFrame({
          schemaVersion: 1,
          action: "enroll",
          runtimeId,
          eventId: randomUUID(),
          issuedAt: Date.now() - 100,
          expiresAt: Date.now() + 30000,
          grant: value,
        });
        return service.execute(enrollment);
      },
    },
  });
  return {
    service,
    principal,
    binding,
    identity,
    policy,
    outer,
    user,
    signFrame,
    get grant() {
      return grant;
    },
    get enrollment() {
      return enrollment;
    },
    get runtimeId() {
      return runtimeId;
    },
    get resolutions() {
      return resolutions;
    },
  };
}
describe.skipIf(!url)("signed guardian bootstrap/service, actual local PostgreSQL", () => {
  it("fresh owner-app identity issues a one-use key/lifetime grant and records real enrollment", async () => {
    const f = await fixture();
    expect(await f.service.provision(f.principal, f.binding.workspaceId)).toMatchObject({
      enrolled: true,
    });
    expect(f.grant.split(".")).toHaveLength(3);
    const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } });
    expect(runtime.phase).toBe("open");
    expect(runtime.outerPublicKeyPem).toBe(f.identity.outerPublicKeyPem);
    const consumed = await db.codexGuardianEnrollmentGrant.findFirstOrThrow({
      where: { runtimeId: runtime.id },
    });
    expect(consumed.consumedAt).not.toBeNull();
    await expect(f.service.execute(f.enrollment)).rejects.toBeInstanceOf(RegistrationRejected);
  });
  it("signed host package/config echoes cannot approve an unlisted or wrong-scope runtime", async () => {
    for (const patch of [
      (p: GuardianIdentityResponse) => {
        p.identity.nodeSha256 = "f".repeat(64);
        p.startup.nodeSha256 = "f".repeat(64);
      },
      (p: GuardianIdentityResponse) => {
        p.identity.configSha256 = "f".repeat(64);
        p.startup.configSha256 = "f".repeat(64);
      },
      (p: GuardianIdentityResponse) => {
        p.startup.workerIdentity.parentPid = 999;
      },
    ]) {
      const f = await fixture(patch);
      await expect(f.service.provision(f.principal, f.binding.workspaceId)).rejects.toBeInstanceOf(
        RegistrationRejected,
      );
      expect(await db.codexGuardianRuntime.count({ where: { ownerId: f.user.id } })).toBe(0);
    }
  });
  it("forged outer proof fails before fresh Coder resolution and old grant cannot switch keys", async () => {
    const f = await fixture();
    await f.service.provision(f.principal, f.binding.workspaceId);
    const before = f.resolutions;
    const forged = { ...(f.enrollment as object), eventId: randomUUID(), proof: "A".repeat(86) };
    await expect(f.service.execute(forged)).rejects.toBeInstanceOf(RegistrationRejected);
    expect(f.resolutions).toBe(before);
    const attacker = generateKeyPairSync("ed25519");
    const switched = f.signFrame({ ...forged, grant: f.grant }, attacker.privateKey);
    await expect(f.service.execute(switched)).rejects.toBeInstanceOf(RegistrationRejected);
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } }))
        .outerPublicKeyPem,
    ).toBe(f.identity.outerPublicKeyPem);
  });
  it("issuer-grant expiry during enrollment SQL update rolls back consumption even while frame remains live", async () => {
    const name = `guardian_enroll_${randomUUID().replaceAll("-", "")}`;
    let installed = false,
      grantExpiresAt = 0;
    const f = await fixture(undefined, async (original, service, key) => {
      const parts = original.split("."),
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      const now = Math.floor(Date.now() / 1000);
      claims.jti = randomUUID();
      claims.iat = now;
      claims.exp = now + 2;
      grantExpiresAt = claims.exp * 1000;
      const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const grant = `${parts[0]}.${body}.${sign(null, Buffer.from(`${parts[0]}.${body}`), key).toString("base64url")}`;
      await service.store.sealGrant({
        ownerId: claims.hiveUserId,
        runtimeId: claims.runtimeId,
        id: claims.jti,
        tokenDigest: sha(grant),
        bindingDigest: guardianDigest(claims),
        issuedAt: new Date(now * 1000),
        expiresAt: new Date(claims.exp * 1000),
      });
      if (!/^[a-f0-9-]{36}$/.test(claims.runtimeId)) throw new Error("Fixture identity rejected");
      await db.$executeRawUnsafe(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('application_name','${name}',true); PERFORM pg_sleep(2.3); RETURN NEW; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER ${name} BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW WHEN(NEW.id='${claims.runtimeId}'::uuid AND NEW.phase='open') EXECUTE FUNCTION ${name}()`,
      );
      installed = true;
      return grant;
    });
    try {
      const pending = f.service.provision(f.principal, f.binding.workspaceId).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForDatabaseSleep(name);
      expect(Date.now()).toBeLessThan(grantExpiresAt);
      const failure = await pending;
      expect(Date.now()).toBeGreaterThanOrEqual(grantExpiresAt);
      if (failure && typeof failure === "object" && "code" in failure)
        throw new Error(`unexpected_fixture_database_failure:${String(failure.code)}`);
      expect(failure).toBeInstanceOf(RegistrationRejected);
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } })).phase,
      ).toBe("reserved");
      const grants = await db.codexGuardianEnrollmentGrant.findMany({
        where: { runtimeId: f.runtimeId },
      });
      expect(grants).toHaveLength(2);
      expect(grants.every((g) => !g.consumedAt)).toBe(true);
    } finally {
      if (installed) {
        await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON codex_guardian_runtimes`);
        await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
      }
    }
  });
});

async function sleepTrigger(runtimeId: string, seconds: number) {
  const name = `guardian_delay_${randomUUID().replaceAll("-", "")}`,
    marker = name;
  if (!/^[a-f0-9-]{36}$/.test(runtimeId) || ![0.4, 1.3].includes(seconds))
    throw new Error("Fixture identity rejected");
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('application_name','${marker}',true); PERFORM pg_sleep(${seconds}); RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW WHEN(NEW.id='${runtimeId}'::uuid) EXECUTE FUNCTION ${name}()`,
  );
  return {
    marker,
    async close() {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON codex_guardian_runtimes`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    },
  };
}
async function waitForDatabaseSleep(marker: string) {
  for (let n = 0; n < 200; n++) {
    const rows = await db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${marker} AND wait_event='PgSleep'`;
    if (rows[0].n === 1) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("Fixture SQL delay was not observed");
}
describe.skipIf(!url)("guardian signed lifetime at real transaction boundary", () => {
  it("expiry while SQL update is pending rolls back the authority extension", async () => {
    const f = await guardianFixture(db),
      before = await db.codexGuardianRuntime.findUniqueOrThrow({
        where: { id: f.guardian.runtime.id },
      });
    const delay = await sleepTrigger(before.id, 1.3);
    try {
      const store = new GuardianAdmissionStore(db, {
        policy: f.guardian.policy,
        encryptionKey: "19".repeat(32),
        expectedConfigSha256: f.guardian.expectedConfigSha256,
        authorizationExpiresAt: Date.now() + 1000,
      });
      const pending = store.fence({
        ownerId: f.user.id,
        runtimeId: before.id,
        runtimeGeneration: before.generation,
        projectId: f.project.id,
        preparationDigest: f.guardian.prepared.admission.preparationDigest,
      });
      void pending.catch(() => {});
      await waitForDatabaseSleep(delay.marker);
      await expect(pending).rejects.toBeInstanceOf(RegistrationRejected);
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: before.id } }))
          .authorityUntil,
      ).toEqual(before.authorityUntil);
    } finally {
      await delay.close();
    }
  });
  it("abort after SQL work starts rolls back and never reports cancellation as commit", async () => {
    const f = await guardianFixture(db),
      before = await db.codexGuardianRuntime.findUniqueOrThrow({
        where: { id: f.guardian.runtime.id },
      }),
      abort = new AbortController();
    const delay = await sleepTrigger(before.id, 0.4);
    try {
      const store = new GuardianAdmissionStore(db, {
        policy: f.guardian.policy,
        encryptionKey: "19".repeat(32),
        expectedConfigSha256: f.guardian.expectedConfigSha256,
        authorizationExpiresAt: Date.now() + 30000,
        signal: abort.signal,
      });
      const pending = store.fence({
        ownerId: f.user.id,
        runtimeId: before.id,
        runtimeGeneration: before.generation,
        projectId: f.project.id,
        preparationDigest: f.guardian.prepared.admission.preparationDigest,
      });
      void pending.catch(() => {});
      await waitForDatabaseSleep(delay.marker);
      abort.abort();
      await expect(pending).rejects.toThrow();
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: before.id } }))
          .authorityUntil,
      ).toEqual(before.authorityUntil);
    } finally {
      await delay.close();
    }
  });
});
