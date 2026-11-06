import { randomUUID } from "node:crypto";
import type { SessionData } from "@hive/auth";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => db,
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.session }));

import { AgentBridgeError } from "@/lib/agents/portable-client.server";
import {
  cloudflareNotificationSourcesRoute,
  type PortableNotificationSourceDependencies,
  portableNotificationSourceRoutes,
} from "@/lib/push/portable-sources.server";
import {
  callbackTokenHash,
  confirmNotificationCredential,
  stageNotificationCredential,
} from "@/lib/push/source-credentials";

const url = process.env.HIVE_AGENT_NOTIFICATION_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).pathname !== "/hive_agent_notification_test")
)
  throw new Error("Dedicated local callback fixture required");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_agent_notification_test",
});
const origin = "https://hive.setup.invalid",
  coderOrigin = "https://coder.setup.invalid";
beforeAll(() => {
  vi.stubEnv("COOKIE_SECRET", "synthetic-local-setup-key");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  vi.stubEnv("CODER_URL", coderOrigin);
  vi.stubEnv("HIVE_AGENT_NOTIFICATION_SOURCES_ENABLED", "true");
});
beforeEach(async () => {
  if (url) await db.notificationSource.deleteMany();
});
afterAll(async () => {
  if (url) await db.notificationSource.deleteMany();
  vi.unstubAllEnvs();
  await db.$disconnect();
});
async function fixture() {
  const id = randomUUID(),
    coderUserId = randomUUID(),
    workspaceId = randomUUID();
  await db.user.create({
    data: {
      id,
      coderUserId,
      coderUrl: coderOrigin,
      username: "setup-proof",
      email: `${id}@example.invalid`,
    },
  });
  const user = { id, coderUserId } as SessionData["user"];
  const session = { user } as SessionData;
  mock.session.mockResolvedValue(session);
  const install = vi.fn(async (op) => ({
    sourceId: op.sourceId,
    generation: op.generation,
    createdAt: op.createdAt,
    credentialHash: callbackTokenHash(op.token),
    callbackOrigin: origin,
  }));
  const deps: PortableNotificationSourceDependencies = {
    enabled: () => true,
    origin: () => origin,
    session: async () => session,
    prepare: async () => ({ workspaceName: "fixture-workspace", install }),
    stage: stageNotificationCredential,
    confirm: confirmNotificationCredential,
    isCurrent: async (ownerId, workspace, op) =>
      !!(await db.notificationSource.findFirst({
        where: {
          id: op.sourceId,
          userId: ownerId,
          workspaceId: workspace,
          credentialGeneration: op.generation,
          tokenHash: callbackTokenHash(op.token),
          pendingTokenHash: null,
        },
      })),
    revoke: async () => {
      throw new Error("Use actual DELETE route");
    },
  };
  const request = (method = "POST", signal?: AbortSignal) =>
    new Request(`${origin}/api/notifications/sources`, {
      method,
      headers: { Origin: origin },
      body: JSON.stringify({ workspaceId }),
      signal,
    });
  return {
    user,
    workspaceId,
    install,
    deps,
    request,
    route: portableNotificationSourceRoutes(deps),
  };
}
describe.skipIf(!url)("portable source setup / real PostgreSQL", () => {
  it("confirms exactly the staged credential after a matching install receipt", async () => {
    const f = await fixture();
    expect((await f.route(f.request())).status).toBe(200);
    const row = await db.notificationSource.findFirstOrThrow({ where: { userId: f.user.id } });
    expect(row.credentialGeneration).toBe(1);
    expect(row.pendingTokenHash).toBeNull();
    expect(row.tokenHash).toBe(callbackTokenHash(f.install.mock.calls[0][0].token));
  });
  it("retains pending/active overlap after lost installation acknowledgment and recovers the same generation", async () => {
    const f = await fixture(),
      real = f.install.getMockImplementation()!;
    f.install.mockRejectedValueOnce(new AgentBridgeError("outcome_unknown"));
    expect((await f.route(f.request())).status).toBe(409);
    const held = await db.notificationSource.findFirstOrThrow({ where: { userId: f.user.id } });
    expect(held.pendingTokenHash).not.toBeNull();
    expect(held.tokenHash).not.toBe(held.pendingTokenHash);
    f.install.mockImplementation(real);
    expect((await f.route(f.request())).status).toBe(200);
    const row = await db.notificationSource.findFirstOrThrow({ where: { id: held.id } });
    expect(row.credentialGeneration).toBe(1);
    expect(row.tokenHash).toBe(held.pendingTokenHash);
    expect(row.pendingTokenHash).toBeNull();
  });
  it("cancellation after installation does not confirm its pending credential", async () => {
    const f = await fixture(),
      controller = new AbortController(),
      real = f.install.getMockImplementation()!;
    f.install.mockImplementation(async (op) => {
      const receipt = await real(op);
      controller.abort();
      return receipt;
    });
    expect((await f.route(f.request("POST", controller.signal))).status).toBe(409);
    expect(
      (await db.notificationSource.findFirstOrThrow({ where: { userId: f.user.id } }))
        .pendingTokenHash,
    ).not.toBeNull();
  });
  it("revocation during installation never resurrects a callback source", async () => {
    const f = await fixture(),
      real = f.install.getMockImplementation()!;
    f.install.mockImplementation(async (op) => {
      await db.notificationSource.deleteMany({ where: { id: op.sourceId, userId: f.user.id } });
      return real(op);
    });
    expect((await f.route(f.request())).status).toBe(409);
    expect(await db.notificationSource.count()).toBe(0);
  });
  it("a late earlier-generation receipt cannot replace a newer confirmed token", async () => {
    const f = await fixture(),
      real = f.install.getMockImplementation()!;
    f.install.mockImplementation(async (op) => {
      await confirmNotificationCredential(
        op.sourceId,
        op.generation,
        op.token,
        "fixture-workspace",
      );
      const newer = await stageNotificationCredential(
        f.user.id,
        f.workspaceId,
        "fixture-workspace",
      );
      await confirmNotificationCredential(
        newer.source.id,
        newer.source.credentialGeneration,
        newer.token,
        "fixture-workspace",
      );
      return real(op);
    });
    expect((await f.route(f.request())).status).toBe(409);
    const row = await db.notificationSource.findFirstOrThrow({ where: { userId: f.user.id } });
    expect(row.credentialGeneration).toBe(2);
    expect(row.pendingTokenHash).toBeNull();
  });
  it("actual owner revocation works without bridge configuration and leaves another owner's source untouched", async () => {
    const f = await fixture();
    await f.route(f.request());
    const other = await fixture();
    await other.route(other.request());
    mock.session.mockResolvedValue({ user: f.user });
    vi.stubEnv("HIVE_AGENT_TOOLS_ENABLED", "false");
    expect((await cloudflareNotificationSourcesRoute(f.request("DELETE"))).status).toBe(200);
    expect(await db.notificationSource.count({ where: { userId: f.user.id } })).toBe(0);
    expect(await db.notificationSource.count({ where: { userId: other.user.id } })).toBe(1);
    expect((await cloudflareNotificationSourcesRoute(f.request("DELETE"))).status).toBe(200);
  });
  it("cancellation while confirmation SQL is pending rolls back the token switch", async () => {
    const f = await fixture(),
      controller = new AbortController(),
      real = f.install.getMockImplementation()!;
    await db.$executeRawUnsafe(
      "CREATE FUNCTION notification_confirm_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER notification_confirm_delay AFTER UPDATE ON notification_sources FOR EACH ROW WHEN (OLD.pending_token_hash IS NOT NULL AND NEW.pending_token_hash IS NULL) EXECUTE FUNCTION notification_confirm_delay()",
    );
    f.install.mockImplementation(async (op) => {
      setTimeout(() => controller.abort(), 30);
      return real(op);
    });
    try {
      expect((await f.route(f.request("POST", controller.signal))).status).toBe(409);
      const row = await db.notificationSource.findFirstOrThrow({ where: { userId: f.user.id } });
      expect(row.pendingTokenHash).not.toBeNull();
      expect(row.tokenHash).not.toBe(row.pendingTokenHash);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER notification_confirm_delay ON notification_sources");
      await db.$executeRawUnsafe("DROP FUNCTION notification_confirm_delay()");
    }
  });
});
