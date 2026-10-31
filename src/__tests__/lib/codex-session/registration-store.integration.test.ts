import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  heartbeatPayload,
  loadActiveRegistrationProjects,
  RegisteredSessionService,
} from "@/lib/codex-session/registered-session.server";
import {
  registrationProofPayload,
  WorkspaceRegistrationAuthority,
} from "@/lib/codex-session/registration.server";
import {
  lockActiveRegistration,
  PrismaRegistrationStore,
} from "@/lib/codex-session/registration-store.server";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
const owners: string[] = [];
afterAll(async () => {
  for (const ownerId of owners) {
    await db.codexRegisteredThread.deleteMany({ where: { ownerId } });
    await db.codexHostSlot.updateMany({ where: { ownerId }, data: { activeRegistrationId: null } });
    await db.codexHostRegistration.deleteMany({ where: { ownerId } });
    await db.codexRegistrationGrant.deleteMany({ where: { ownerId } });
    await db.codexHostSlot.deleteMany({ where: { ownerId } });
    await db.deliveryConversation.deleteMany({ where: { ownerId } });
    await db.deliveryProject.deleteMany({ where: { ownerId } });
    await db.user.delete({ where: { id: ownerId } });
  }
  await db.$disconnect();
});
async function fixture(sessionTransport: "direct" | "relay" = "direct") {
  const user = await db.user.create({
    data: {
      coderUrl: "https://coder.example.com",
      coderUserId: randomUUID(),
      username: "fixture",
      email: "fixture@example.com",
    },
  });
  owners.push(user.id);
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/repo",
    },
  });
  const issuer = generateKeyPairSync("ed25519"),
    host = generateKeyPairSync("ed25519");
  const workspace = {
    id: randomUUID(),
    name: "fixture",
    owner_name: "owner",
    owner_id: user.coderUserId,
    template_id: randomUUID(),
    latest_build: {
      id: randomUUID(),
      status: "running" as const,
      job: { status: "succeeded", error: "" },
    },
  };
  const agent = {
    id: randomUUID(),
    name: "main",
    status: "connected" as const,
    apps: [
      {
        id: randomUUID(),
        slug: "codex-session",
        url: "http://127.0.0.1:13341/",
        sharing_level: "owner",
        subdomain: true,
        external: false,
      },
    ],
  };
  const coder = {
    getBaseUrl: () => user.coderUrl,
    getWorkspace: async () => structuredClone(workspace),
    getWorkspaceResources: async () => [
      { id: "resource", name: "pod", type: "pod", agents: [structuredClone(agent)] },
    ],
    getApplicationsHost: async () => "*.coder.example.com",
  };
  const config = {
    privateKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    keyId: "fixture",
    hiveOrigin: "https://hive.example.com",
    softwareTemplateIds: [workspace.template_id],
    appSlug: "codex-session",
    gatewayPort: 13341,
    cookieDomains: [],
    sessionTransport,
  };
  const store = new PrismaRegistrationStore(db),
    principal = { hiveUserId: user.id, coderUserId: user.coderUserId };
  const authority = new WorkspaceRegistrationAuthority(config, {
    store,
    coderForPrincipal: async () => coder,
    authorizedProjects: async () => [{ projectId: project.id, repositoryId: "123" }],
  });
  const service = new RegisteredSessionService(db, config, authority, store);
  const issue = () => authority.issue(principal, workspace.id, agent.id, [project.id]);
  const request = (grant: string, threadId = randomUUID()) => {
    const value = {
      grant,
      serverInstanceId: randomUUID(),
      protocolVersion: "0.165.0" as const,
      threads: [{ projectId: project.id, repositoryId: "123", threadId }],
      hostPublicKeyPem: host.publicKey.export({ format: "pem", type: "spki" }).toString(),
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(registrationProofPayload(value)), host.privateKey).toString(
        "base64url",
      ),
    };
  };
  const heartbeat = (
    r: { registrationId: string; sequence: number; nonce: string },
    serverInstanceId: string,
  ) => {
    const value = {
      registrationId: r.registrationId,
      serverInstanceId,
      sequence: r.sequence + 1,
      nonce: r.nonce,
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(heartbeatPayload(value)), host.privateKey).toString(
        "base64url",
      ),
    };
  };
  return {
    user,
    project,
    workspace,
    agent,
    principal,
    authority,
    store,
    service,
    issue,
    request,
    heartbeat,
  };
}
describe.skipIf(!url)("durable Codex registration", () => {
  it("allows one concurrent redemption, persists conversation and issues exact owner read grant", async () => {
    const f = await fixture(),
      grant = await f.issue(),
      request = f.request(grant.grant);
    const result = await Promise.allSettled([f.service.redeem(request), f.service.redeem(request)]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.codexHostRegistration.count({ where: { ownerId: f.user.id } })).toBe(1);
    const read = await f.service.readGrant(f.principal, f.project.id);
    expect(read.binding.threadId).toBe(request.threads[0].threadId);
    expect(read.binding.ownerId).toBe(f.user.coderUserId);
    await expect(
      f.service.readGrant({ ...f.principal, hiveUserId: randomUUID() }, f.project.id),
    ).rejects.toThrow();
    await expect(
      f.service.readGrant({ ...f.principal, coderUserId: randomUUID() }, f.project.id),
    ).rejects.toThrow();
  });
  it("fences older generations and revokes prior lifetimes atomically while preserving history", async () => {
    const f = await fixture(),
      a = await f.issue(),
      ra = f.request(a.grant),
      first = await f.service.redeem(ra);
    const old = await f.issue(),
      latest = await f.issue();
    await expect(f.service.redeem(f.request(old.grant))).rejects.toThrow();
    await expect(f.store.active(first.registrationId)).rejects.toThrow();
    const next = await f.service.redeem(f.request(latest.grant));
    expect(next.registrationId).not.toBe(first.registrationId);
    expect(
      (await db.codexHostRegistration.findUniqueOrThrow({ where: { id: first.registrationId } }))
        .revokedAt,
    ).not.toBeNull();
    expect(await db.deliveryConversation.count({ where: { ownerId: f.user.id } })).toBe(2);
  });
  it("denies changed Coder build or owner on redeem and every read/heartbeat renewal", async () => {
    const f = await fixture(),
      grant = await f.issue();
    f.workspace.latest_build.id = randomUUID();
    await expect(f.service.redeem(f.request(grant.grant))).rejects.toThrow();
    const next = await f.issue(),
      request = f.request(next.grant),
      r = await f.service.redeem(request);
    f.workspace.owner_id = randomUUID();
    await expect(f.service.readGrant(f.principal, f.project.id)).rejects.toThrow();
    await expect(f.service.heartbeat(f.heartbeat(r, request.serverInstanceId))).rejects.toThrow();
  });
  it("renews once and returns the same acknowledgement for an exact duplicate", async () => {
    const f = await fixture(),
      g = await f.issue(),
      request = f.request(g.grant),
      r = await f.service.redeem(request),
      heartbeat = f.heartbeat(r, request.serverInstanceId);
    const result = await Promise.allSettled([
      f.service.heartbeat(heartbeat),
      f.service.heartbeat(heartbeat),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(result[0]).toEqual(result[1]);
    expect(
      (await db.codexHostRegistration.findUniqueOrThrow({ where: { id: r.registrationId } }))
        .heartbeatSequence,
    ).toBe(1);
    const renewed = result.find((r) => r.status === "fulfilled");
    expect(renewed?.status === "fulfilled" && renewed.value.nonce).not.toBe(r.nonce);
    await db.codexHostRegistration.update({
      where: { id: r.registrationId },
      data: { registeredAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(f.service.readGrant(f.principal, f.project.id)).rejects.toThrow();
    await expect(f.service.heartbeat(heartbeat)).rejects.toThrow();
  });
  it("rolls back a project mismatch and enforces composite owner FKs", async () => {
    const f = await fixture(),
      other = await fixture(),
      g = await f.issue(),
      request = f.request(g.grant);
    await db.deliveryProject.update({
      where: { id: f.project.id },
      data: { providerRepositoryId: "999" },
    });
    await expect(f.service.redeem(request)).rejects.toThrow();
    expect(await db.codexHostRegistration.count({ where: { ownerId: f.user.id } })).toBe(0);
    await expect(
      db.codexRegistrationGrant.create({
        data: {
          id: randomUUID(),
          ownerId: other.user.id,
          slotId: (await db.codexHostSlot.findFirstOrThrow({ where: { ownerId: f.user.id } })).id,
          generation: 2,
          binding: {},
          bindingDigest: "test",
          expiresAt: new Date(Date.now() + 60000),
        },
      }),
    ).rejects.toThrow();
  });
  it("locks active authority within the same controller transaction", async () => {
    const f = await fixture(),
      g = await f.issue(),
      request = f.request(g.grant),
      r = await f.service.redeem(request);
    const a = await db.$transaction((tx) =>
      lockActiveRegistration(tx, { ownerId: f.user.id, registrationId: r.registrationId }),
    );
    expect(a.registration.threads[0].nativeThreadId).toBe(request.threads[0].threadId);
    await expect(
      db.$transaction((tx) =>
        lockActiveRegistration(tx, { ownerId: randomUUID(), registrationId: r.registrationId }),
      ),
    ).rejects.toThrow();
    // Checkout state is deliberately absent: durable native history remains readable.
    expect((await f.service.readGrant(f.principal, f.project.id)).binding.threadId).toBe(
      request.threads[0].threadId,
    );
  });
  it("serializes conflicting seals and returns one consumed outcome without a duplicate insert", async () => {
    const f = await fixture(),
      issued = await f.issue(),
      grantId = randomUUID(),
      expiresAt = Math.floor(Date.now() / 1000) + 60;
    const generation = await f.store.reserve({ grantId, binding: issued.binding, expiresAt });
    // Force both callers to finish their locating read before either can acquire
    // the slot lock. This reproduces stale pre-lock snapshots deterministically.
    const barrier = () => {
      let count = 0;
      let release: () => void = () => {};
      const ready = new Promise<void>((r) => {
        release = r;
      });
      return async () => {
        if (++count <= 2) {
          if (count === 2) release();
          await ready;
        }
      };
    };
    let gate = barrier();
    const synchronized = db.$extends({
      query: {
        codexRegistrationGrant: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (args.where.id === grantId) await gate();
            return row;
          },
          async findUniqueOrThrow({ args, query }) {
            const row = await query(args);
            if (args.where.id === grantId) await gate();
            return row;
          },
        },
      },
    });
    const racedStore = new PrismaRegistrationStore(synchronized as unknown as PrismaClient);

    const attempts = await Promise.allSettled(
      ["a".repeat(64), "b".repeat(64)].map((grantDigest) =>
        racedStore.seal({ grantId, generation, grantDigest }),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await db.codexRegistrationGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.tokenDigest).toBe(
      attempts[0].status === "fulfilled" ? "a".repeat(64) : "b".repeat(64),
    );
    const request = f.request(issued.grant),
      now = Math.floor(Date.now() / 1000);
    const input = {
      grantId,
      grantDigest: row.tokenDigest ?? "",
      expiresAt,
      now,
      registration: {
        binding: issued.binding,
        serverInstanceId: request.serverInstanceId,
        protocolVersion: request.protocolVersion,
        threads: request.threads,
        hostPublicKeyPem: request.hostPublicKeyPem,
        generation,
        registeredAt: now,
        expiresAt: now + 60,
      },
    };
    gate = barrier();
    const consumed = await Promise.all([
      racedStore.consumeAndRegister(input),
      racedStore.consumeAndRegister(input),
    ]);
    expect(consumed.sort()).toEqual([false, true]);
    expect(await db.codexHostRegistration.count({ where: { ownerId: f.user.id } })).toBe(1);
    await expect(
      f.store.seal({ grantId, generation, grantDigest: "c".repeat(64) }),
    ).rejects.toThrow();
    expect(
      (await db.codexRegistrationGrant.findUniqueOrThrow({ where: { id: grantId } })).tokenDigest,
    ).toBe(row.tokenDigest);
  });
  it("selects explicit workspace projects despite more than32 retained owner projects", async () => {
    const f = await fixture(),
      other = await fixture();
    await db.deliveryProject.createMany({
      data: Array.from({ length: 33 }, (_, n) => ({
        id: randomUUID(),
        ownerId: f.user.id,
        provider: "github",
        providerRepositoryId: String(1000 + n),
        providerAccountId: "456",
        fullName: `fixture/retained-${n}`,
      })),
    });
    expect(await loadActiveRegistrationProjects(db, f.principal, [f.project.id])).toEqual([
      { projectId: f.project.id, repositoryId: "123" },
    ]);
    await expect(loadActiveRegistrationProjects(db, f.principal, [])).rejects.toThrow();
    await expect(
      loadActiveRegistrationProjects(db, f.principal, [other.project.id]),
    ).rejects.toThrow();
    await expect(
      loadActiveRegistrationProjects(
        db,
        f.principal,
        Array.from({ length: 33 }, () => randomUUID()),
      ),
    ).rejects.toThrow();
  });
  it("recovers a lost latest heartbeat acknowledgement without extending expiry or accepting changed/older requests", async () => {
    const f = await fixture(),
      g = await f.issue(),
      request = f.request(g.grant),
      r = await f.service.redeem(request),
      heartbeat = f.heartbeat(r, request.serverInstanceId);
    const accepted = await f.service.heartbeat(heartbeat); // Pretend response was lost.
    const before = await db.codexHostRegistration.findUniqueOrThrow({
      where: { id: r.registrationId },
    });
    const recovered = await f.service.heartbeat(heartbeat);
    expect(recovered).toEqual(accepted);
    const after = await db.codexHostRegistration.findUniqueOrThrow({
      where: { id: r.registrationId },
    });
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.heartbeatNonce).toBe(before.heartbeatNonce);
    expect(after.heartbeatSequence).toBe(before.heartbeatSequence);
    await expect(
      f.service.heartbeat(f.heartbeat({ ...r, nonce: randomUUID() }, request.serverInstanceId)),
    ).rejects.toThrow();
    await f.service.heartbeat(f.heartbeat(accepted, request.serverInstanceId));
    await expect(f.service.heartbeat(heartbeat)).rejects.toThrow();
    await db.codexHostRegistration.update({
      where: { id: r.registrationId },
      data: { revokedAt: new Date() },
    });
    await expect(
      f.service.heartbeat(f.heartbeat(accepted, request.serverInstanceId)),
    ).rejects.toThrow();
  });
});

it.skipIf(!url)(
  "authorizes exact registered relay targets and retains native ticket audience",
  async () => {
    const f = await fixture("relay"),
      issued = await f.issue(),
      request = f.request(issued.grant);
    await f.service.redeem(request);
    const target = await f.service.authorizeRelayTarget(f.principal, f.project.id);
    const grant = await f.service.readGrant(f.principal, f.project.id);
    expect(grant.url).toBe(`https://hive.example.com/api/projects/${f.project.id}/session`);
    expect(target.binding).toEqual(grant.binding);
    const terminal = await f.service.terminalGrant(f.principal, f.project.id);
    expect(terminal.url).toBe(`https://hive.example.com/api/projects/${f.project.id}/terminal`);
    expect(terminal.binding).toEqual(target.binding);
    expect(
      JSON.parse(Buffer.from(terminal.ticket.split(".")[1], "base64url").toString()).scope,
    ).toBe("session:terminal");
    expect(JSON.parse(Buffer.from(grant.ticket.split(".")[1], "base64url").toString()).aud).toBe(
      target.appOrigin,
    );
    await expect(
      f.service.authorizeRelayTarget({ ...f.principal, hiveUserId: randomUUID() }, f.project.id),
    ).rejects.toThrow();
    f.workspace.latest_build.id = randomUUID();
    await expect(f.service.authorizeRelayTarget(f.principal, f.project.id)).rejects.toThrow();
  },
);
