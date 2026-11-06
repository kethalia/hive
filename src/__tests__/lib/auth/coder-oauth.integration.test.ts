import { createHash, randomUUID } from "node:crypto";
import { AuthServiceClient, decrypt, encrypt } from "@hive/auth";
import { createDatabaseRequest, PrismaClient } from "@hive/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeOwnedWorkspacePty } from "../../../../deploy/cloudflare/app/generic-terminal-runtime";
import {
  completeCoderOAuth,
  startCoderOAuth,
} from "../../../../services/auth/src/auth/coder-oauth";
import { getUsableCoderCredential } from "../../../../services/auth/src/auth/coder-oauth-credentials";
import { deleteSession, getSessionById } from "../../../../services/auth/src/auth/session";
import {
  getDecryptedCoderToken,
  getTokenStatus,
} from "../../../../services/auth/src/auth/token-status";
import { createFetchAuthHandler } from "../../../../services/auth/src/fetch-handler";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Isolated loopback auth fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
const key = "19".repeat(32),
  origin = "https://coder.oauth-fixture.invalid",
  publicOrigin = "https://hive.oauth-fixture.invalid";
beforeEach(() => {
  vi.stubEnv("CODER_URL", origin);
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", publicOrigin);
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
  vi.stubEnv("HIVE_CODER_OAUTH_CLIENT_ID", randomUUID());
  vi.stubEnv("HIVE_CODER_OAUTH_CLIENT_SECRET", "synthetic-static-secret");
  vi.stubEnv("ENCRYPTION_KEY", key);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => db.$disconnect());
function provider() {
  const identity = {
    id: randomUUID(),
    username: "oauth-fixture",
    email: "oauth@example.invalid",
    status: "active",
  };
  let codeCount = 0,
    refreshCount = 0,
    failToken = false,
    refreshDelay = 0,
    refreshIdentity = identity.id;
  const send = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    expect(new URL(target).origin).toBe(origin);
    expect(init?.redirect).toBe("manual");
    if (target === `${origin}/.well-known/oauth-authorization-server`)
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth2/authorize`,
        token_endpoint: `${origin}/oauth2/tokens`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        response_types_supported: ["code"],
      });
    if (target === `${origin}/oauth2/tokens`) {
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
      const body = new URLSearchParams(String(init?.body));
      expect(body.has("client_secret")).toBe(false);
      if (failToken)
        return Response.json({ error: "upstream-secret-must-not-escape" }, { status: 503 });
      if (body.get("grant_type") === "refresh_token") {
        refreshCount++;
        if (refreshDelay) await new Promise((done) => setTimeout(done, refreshDelay));
        return Response.json({
          access_token: "refresh-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "coder:all",
        });
      }
      codeCount++;
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.get("redirect_uri")).toBe(`${publicOrigin}/api/auth/coder/callback`);
      return Response.json({
        access_token: `access-${codeCount}`,
        refresh_token: `refresh-${codeCount}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "coder:all",
      });
    }
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
    if (target === `${origin}/api/v2/applications/host`)
      return Response.json({ host: "*.apps.oauth-fixture.invalid" });
    if (target === `${origin}/api/v2/users/me`)
      return Response.json({
        ...identity,
        id:
          new Headers(init?.headers).get("authorization") === "Bearer refresh-access"
            ? refreshIdentity
            : identity.id,
      });
    throw new Error("Unexpected provider endpoint");
  });
  const start = () => startCoderOAuth({ db, send: send as typeof fetch });
  vi.stubGlobal("fetch", send);
  const finish = async (
    flow: Awaited<ReturnType<typeof startCoderOAuth>>,
    patch: Record<string, unknown> = {},
  ) =>
    completeCoderOAuth(
      {
        state: new URL(flow.authorizationUrl).searchParams.get("state")!,
        browserSecret: flow.browserSecret,
        code: "fixture-code",
        ...patch,
      },
      { db, send: send as typeof fetch },
    );
  return {
    identity,
    send,
    start,
    finish,
    counts: () => ({ codeCount, refreshCount }),
    fail: () => {
      failToken = true;
    },
    delay: (ms: number) => {
      refreshDelay = ms;
    },
    wrongRefreshOwner: () => {
      refreshIdentity = randomUUID();
    },
  };
}
async function expireAccess(userId: string) {
  await db.coderToken.update({ where: { userId }, data: { expiresAt: new Date(Date.now() - 1) } });
}
describe.skipIf(!url)("Coder browser OAuth / actual local PostgreSQL", () => {
  it("an immediate 401 returned after provider cancellation cannot change the credential or sessions", async () => {
    const p = provider(),
      first = await p.finish(await p.start());
    const before = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    const controller = new AbortController();
    const send: typeof fetch = async () => {
      controller.abort();
      return new Response("private rejected token", { status: 401 });
    };
    await expect(
      getUsableCoderCredential(first.user.id, { db, send, signal: controller.signal }),
    ).rejects.toThrow();
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } })).toEqual(
      before,
    );
    expect(await db.session.count({ where: { userId: first.user.id } })).toBe(1);
  });
  it.each([
    "credential-update",
    "session-delete",
  ])("cancellation after actual SQL %s rolls back both credential and sessions", async (stage) => {
    const p = provider(),
      first = await p.finish(await p.start());
    await p.finish(await p.start());
    const before = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    const sessions = await db.session.findMany({
      where: { userId: first.user.id },
      orderBy: { id: "asc" },
    });
    const controller = new AbortController();
    let mutated = false;
    const intercepted = db.$extends({
      query: {
        coderToken: {
          async updateMany({ args, query }) {
            const result = await query(args);
            if (stage === "credential-update") {
              mutated = result.count === 1;
              controller.abort();
            }
            return result;
          },
        },
        session: {
          async deleteMany({ args, query }) {
            const result = await query(args);
            if (stage === "session-delete") {
              mutated = result.count === 2;
              controller.abort();
            }
            return result;
          },
        },
      },
    });
    const send: typeof fetch = async () => new Response(null, { status: 401 });
    await expect(
      getUsableCoderCredential(first.user.id, {
        db: intercepted as unknown as PrismaClient,
        send,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(mutated).toBe(true);
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } })).toEqual(
      before,
    );
    expect(
      await db.session.findMany({ where: { userId: first.user.id }, orderBy: { id: "asc" } }),
    ).toEqual(sessions);
  });
  it.each([
    "identity401",
    "invalid_grant",
  ])("definitive %s invalidates existing sessions permanently across later sign-in", async (failure) => {
    const p = provider(),
      first = await p.finish(await p.start()),
      second = await p.finish(await p.start());
    if (failure === "invalid_grant") await expireAccess(first.user.id);
    const send: typeof fetch = async () =>
      failure === "identity401"
        ? new Response(null, { status: 401 })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(getUsableCoderCredential(first.user.id, { db, send })).rejects.toThrow(
      "coder_oauth_reconnect",
    );
    expect(await db.session.count({ where: { userId: first.user.id } })).toBe(0);
    const reconnect = await p.finish(await p.start());
    expect(await getSessionById(first.sessionId, db)).toBeNull();
    expect(await getSessionById(second.sessionId, db)).toBeNull();
    expect(await getSessionById(reconnect.sessionId, db)).not.toBeNull();
  });
  it("measures fresh session/token service reads and retains ordinary local logout", async () => {
    const p = provider(),
      first = await p.finish(await p.start()),
      second = await p.finish(await p.start());
    const secret = "a".repeat(64),
      handler = createFetchAuthHandler(secret);
    const client = new AuthServiceClient("https://auth.fixture.invalid", 20000, {
      serviceSecret: secret,
      fetch: async (input, init) =>
        createDatabaseRequest(() => db).run(() => handler(new Request(input, init))),
    });
    p.send.mockClear();
    expect((await client.getSession(first.sessionId))?.userId).toBe(first.user.id);
    expect(p.send).toHaveBeenCalledTimes(1);
    expect((await client.getCoderToken(first.sessionId))?.token).toBe("access-2");
    expect(p.send).toHaveBeenCalledTimes(3);
    const workspaceId = randomUUID(),
      agentId = randomUUID(),
      buildId = randomUUID(),
      original = p.send.getMockImplementation()!;
    p.send.mockImplementation(async (input, init) =>
      String(input) === `${origin}/api/v2/workspaces/${workspaceId}`
        ? Response.json({
            id: workspaceId,
            owner_id: p.identity.id,
            latest_build: {
              id: buildId,
              status: "running",
              resources: [{ agents: [{ id: agentId, status: "connected" }] }],
            },
          })
        : original(input, init),
    );
    p.send.mockClear();
    await authorizeOwnedWorkspacePty(
      first.sessionId,
      {
        CODER_URL: origin,
        AUTH_SERVICE_SECRET: secret,
        AUTH_SERVICE: {
          fetch: async (input, init) =>
            createDatabaseRequest(() => db).run(() => handler(new Request(input, init))),
        },
      },
      workspaceId,
      agentId,
      new AbortController().signal,
      p.send as typeof fetch,
    );
    expect(
      p.send.mock.calls.filter(([input]) => String(input) === `${origin}/api/v2/users/me`),
    ).toHaveLength(4);
    expect(p.send).toHaveBeenCalledTimes(5);
    const before = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    await createDatabaseRequest(() => db).run(() => deleteSession(first.sessionId));
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } })).toEqual(
      before,
    );
    expect(await getSessionById(first.sessionId, db)).toBeNull();
    expect(await getSessionById(second.sessionId, db)).not.toBeNull();
  });
  it.each([
    400, 401, 403,
  ])("structured token invalid_client (%s) releases only its unconsumed refresh claim", async (status) => {
    const p = provider(),
      first = await p.finish(await p.start());
    await expireAccess(first.user.id);
    const before = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    const send: typeof fetch = async () =>
      Response.json(
        { error: "invalid_client", error_description: "private client detail" },
        { status },
      );
    await expect(getUsableCoderCredential(first.user.id, { db, send })).rejects.toThrow(
      "coder_oauth_unavailable",
    );
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } })).toEqual({
      ...before,
      updatedAt: expect.any(Date),
    });
    expect(
      (await getUsableCoderCredential(first.user.id, { db, send: p.send as typeof fetch })).token,
    ).toBe("refresh-access");
  });
  it.each([
    "invalid_grant",
    "unknown-403",
    "unavailable",
  ])("token %s distinguishes revoked from ambiguous rotating grants", async (failure) => {
    const p = provider(),
      first = await p.finish(await p.start());
    await expireAccess(first.user.id);
    const send: typeof fetch = async () =>
      failure === "invalid_grant"
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : new Response("private ambiguous provider response", {
            status: failure === "unknown-403" ? 403 : 503,
          });
    await expect(getUsableCoderCredential(first.user.id, { db, send })).rejects.toThrow(
      failure === "invalid_grant" ? "coder_oauth_reconnect" : "coder_oauth_unavailable",
    );
    const current = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    expect(current.oauthRefreshState).toBe(
      failure === "invalid_grant" ? "reconnect" : "refreshing",
    );
    expect(current.version).toBe(1);
    expect(decrypt(current, key)).toBe("access-1");
  });
  it("detects a fresh revoked grant for all sessions and token/status readers without fallback", async () => {
    const p = provider(),
      first = await p.finish(await p.start()),
      second = await p.finish(await p.start());
    const before = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    p.send.mockClear();
    p.send.mockImplementation(
      async () => new Response("private provider failure", { status: 401 }),
    );
    expect(await getSessionById(first.sessionId, db)).toBeNull();
    expect(await getSessionById(second.sessionId, db)).toBeNull();
    const request = createDatabaseRequest(() => db);
    await request.run(async () => {
      expect(await getTokenStatus(first.user.id)).toMatchObject({ status: "expired" });
      await expect(getDecryptedCoderToken(first.user.id)).rejects.toThrow("coder_oauth_reconnect");
    });
    const after = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    expect(after).toEqual({
      ...before,
      oauthRefreshState: "reconnect",
      updatedAt: expect.any(Date),
    });
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(String(p.send.mock.calls[0][0])).toBe(`${origin}/api/v2/users/me`);
    expect(await db.session.count({ where: { userId: first.user.id } })).toBe(0);
  });
  it.each([
    "wrong-owner",
    "inactive",
    "deleted",
  ])("holds a fresh %s identity for reconnect", async (failure) => {
    const p = provider(),
      first = await p.finish(await p.start());
    p.send.mockImplementation(async () =>
      Response.json({
        ...p.identity,
        ...(failure === "wrong-owner" ? { id: randomUUID() } : {}),
        ...(failure === "inactive" ? { status: "suspended" } : {}),
        ...(failure === "deleted" ? { deleted: true } : {}),
      }),
    );
    await expect(
      getUsableCoderCredential(first.user.id, { db, send: p.send as typeof fetch }),
    ).rejects.toThrow("coder_oauth_reconnect");
    expect(
      (await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } }))
        .oauthRefreshState,
    ).toBe("reconnect");
  });
  it.each([
    403,
    429,
    503,
    "network",
    "timeout",
    "missing-status",
  ])("fresh identity %s fails the request without revoking credentials", async (failure) => {
    const p = provider(),
      first = await p.finish(await p.start());
    const before = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    const controller = new AbortController();
    const send: typeof fetch = async () => {
      if (failure === "network") throw new Error("private network detail");
      if (failure === "timeout") {
        controller.abort();
        return new Promise<Response>(() => {});
      }
      if (failure === "missing-status") return Response.json({ ...p.identity, status: undefined });
      return new Response("private provider detail", { status: Number(failure) });
    };
    await expect(
      getUsableCoderCredential(first.user.id, { db, send, signal: controller.signal }),
    ).rejects.toThrow("coder_oauth_unavailable");
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } })).toEqual(
      before,
    );
  });
  it.each([
    "refresh",
    "login",
  ])("a delayed fresh-token 401 reloads the %s winner without invalidating it", async (winner) => {
    const p = provider(),
      first = await p.finish(await p.start());
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((done) => {
        entered = done;
      }),
      resumed = new Promise<void>((done) => {
        release = done;
      });
    let checks = 0;
    const send: typeof fetch = async (input, init) => {
      checks++;
      if (new Headers(init?.headers).get("Authorization") === "Bearer access-1") {
        entered();
        await resumed;
        return new Response("private old credential failure", { status: 401 });
      }
      return p.send(input, init);
    };
    const pending = getUsableCoderCredential(first.user.id, { db, send });
    await waiting;
    let expected: string;
    let winnerSession: string | undefined;
    if (winner === "refresh") {
      await expireAccess(first.user.id);
      expected = (
        await getUsableCoderCredential(first.user.id, { db, send: p.send as typeof fetch })
      ).token;
    } else {
      winnerSession = (await p.finish(await p.start())).sessionId;
      expected = "access-2";
    }
    const before = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    release();
    expect((await pending).token).toBe(expected);
    expect(checks).toBe(2);
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } })).toEqual(
      before,
    );
    expect(await getSessionById(first.sessionId, db)).not.toBeNull();
    if (winnerSession) expect(await getSessionById(winnerSession, db)).not.toBeNull();
  });
  it("bounds concurrent replacement retries to three identity calls", async () => {
    const p = provider(),
      first = await p.finish(await p.start());
    let calls = 0;
    const send: typeof fetch = async () => {
      calls++;
      await db.coderToken.update({
        where: { userId: first.user.id },
        data: { version: { increment: 1 } },
      });
      return Response.json(p.identity);
    };
    await expect(getUsableCoderCredential(first.user.id, { db, send })).rejects.toThrow(
      "coder_oauth_refresh_pending",
    );
    expect(calls).toBe(3);
    expect(
      (await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } }))
        .oauthRefreshState,
    ).toBe("idle");
  });
  it("commits PKCE-bound verified identity, encrypted access/refresh and a normal Hive session atomically", async () => {
    const p = provider(),
      flow = await p.start(),
      request = new URL(flow.authorizationUrl);
    expect(request.origin).toBe(origin);
    expect(request.searchParams.get("code_challenge_method")).toBe("S256");
    const storedFlow = await db.coderOAuthFlow.findUniqueOrThrow({
      where: {
        stateHash: createHash("sha256").update(request.searchParams.get("state")!).digest("hex"),
      },
    });
    const verifier = decrypt(
      {
        ciphertext: storedFlow.verifierCiphertext,
        iv: storedFlow.verifierIv,
        authTag: storedFlow.verifierAuthTag,
      },
      key,
    );
    expect(request.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(flow.authorizationUrl).not.toContain(verifier);
    expect(flow.authorizationUrl).not.toContain("synthetic-static-secret");
    const result = await p.finish(flow, { ownerId: randomUUID() }),
      token = await db.coderToken.findUniqueOrThrow({ where: { userId: result.user.id } });
    expect(result.applicationsHost).toBe("*.apps.oauth-fixture.invalid");
    expect(token.credentialSource).toBe("oauth");
    expect(token.remoteKeyId).toBeNull();
    expect(decrypt(token, key)).toBe("access-1");
    expect(
      decrypt(
        {
          ciphertext: token.refreshCiphertext!,
          iv: token.refreshIv!,
          authTag: token.refreshAuthTag!,
        },
        key,
      ),
    ).toBe("refresh-1");
    expect((await db.user.findUniqueOrThrow({ where: { id: result.user.id } })).coderUserId).toBe(
      p.identity.id,
    );
    expect(
      (await db.session.findUniqueOrThrow({ where: { sessionId: result.sessionId } })).userId,
    ).toBe(result.user.id);
    expect((await getSessionById(result.sessionId, db))?.user.id).toBe(result.user.id);
    await expect(p.finish(flow)).rejects.toThrow("coder_oauth_flow_invalid");
    expect(p.counts().codeCount).toBe(1);
  });
  it("wrong browser binding cannot consume a flow; denial consumes it without token exchange", async () => {
    const p = provider(),
      flow = await p.start();
    await expect(p.finish(flow, { browserSecret: "a".repeat(43) })).rejects.toThrow(
      "coder_oauth_flow_invalid",
    );
    await expect(p.finish(flow, { denied: true })).rejects.toThrow("coder_oauth_flow_invalid");
    await expect(p.finish(flow)).rejects.toThrow("coder_oauth_flow_invalid");
    expect(p.counts().codeCount).toBe(0);
  });
  it("racing callbacks can exchange a code and create a session only once", async () => {
    const p = provider(),
      flow = await p.start();
    const results = await Promise.allSettled([p.finish(flow), p.finish(flow)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(p.counts().codeCount).toBe(1);
  });
  it("expired or changed-origin flow never reaches the provider exchange", async () => {
    const p = provider(),
      flow = await p.start(),
      stateHash = createHash("sha256")
        .update(new URL(flow.authorizationUrl).searchParams.get("state")!)
        .digest("hex");
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role=replica`;
      await tx.coderOAuthFlow.update({
        where: { stateHash },
        data: {
          createdAt: new Date(Date.now() - 1200000),
          expiresAt: new Date(Date.now() - 600000),
        },
      });
    });
    await expect(p.finish(flow)).rejects.toThrow("coder_oauth_flow_invalid");
    expect(p.counts().codeCount).toBe(0);
    const next = await p.start();
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://other-hive.invalid");
    await expect(p.finish(next)).rejects.toThrow("coder_oauth_flow_invalid");
    expect(p.counts().codeCount).toBe(0);
  });
  it("failed sign-in preserves an existing managed credential, sessions and owner identity", async () => {
    const p = provider(),
      owner = await db.user.create({
        data: {
          coderUrl: origin,
          coderUserId: p.identity.id,
          username: "existing",
          email: p.identity.email,
        },
      }),
      encrypted = encrypt("existing-managed-key", key);
    await db.coderToken.create({
      data: {
        userId: owner.id,
        ...encrypted,
        ciphertext: new Uint8Array(encrypted.ciphertext),
        iv: new Uint8Array(encrypted.iv),
        authTag: new Uint8Array(encrypted.authTag),
        expiresAt: new Date(Date.now() + 3600000),
        remoteKeyId: "known-key",
        credentialSource: "managed_key",
      },
    });
    const session = await db.session.create({
        data: { userId: owner.id, expiresAt: new Date(Date.now() + 3600000) },
      }),
      before = await db.coderToken.findUniqueOrThrow({ where: { userId: owner.id } }),
      flow = await p.start();
    p.fail();
    await expect(p.finish(flow)).rejects.toThrow("coder_oauth_unavailable");
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: owner.id } })).toEqual(before);
    expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
  });
  it("serializes concurrent refresh and rotates encrypted access/refresh with version CAS", async () => {
    const p = provider(),
      result = await p.finish(await p.start());
    await expireAccess(result.user.id);
    p.delay(150);
    const results = await Promise.all([
      getUsableCoderCredential(result.user.id, { db, send: p.send as typeof fetch }),
      getUsableCoderCredential(result.user.id, { db, send: p.send as typeof fetch }),
    ]);
    expect(results.map((result) => result.token)).toEqual(["refresh-access", "refresh-access"]);
    expect(p.counts().refreshCount).toBe(1);
    const current = await db.coderToken.findUniqueOrThrow({ where: { userId: result.user.id } });
    expect(current.version).toBe(2);
    expect(current.oauthRefreshState).toBe("idle");
    expect(
      decrypt(
        {
          ciphertext: current.refreshCiphertext!,
          iv: current.refreshIv!,
          authTag: current.refreshAuthTag!,
        },
        key,
      ),
    ).toBe("rotated-refresh");
  });
  it("a concurrent waiter survives two valid provider legs whose total exceeds five seconds", async () => {
    const p = provider(),
      result = await p.finish(await p.start());
    await expireAccess(result.user.id);
    let refreshEntered!: () => void;
    const entered = new Promise<void>((done) => {
      refreshEntered = done;
    });
    const send: typeof fetch = async (input, init) => {
      const target = String(input);
      if (target === `${origin}/oauth2/tokens` || target === `${origin}/api/v2/users/me`) {
        if (target === `${origin}/oauth2/tokens`) refreshEntered();
        await new Promise((done) => setTimeout(done, 2650));
      }
      return p.send(input, init);
    };
    const first = getUsableCoderCredential(result.user.id, { db, send });
    await entered;
    const waiter = getUsableCoderCredential(result.user.id, { db, send });
    const values = await Promise.all([first, waiter]);
    expect(values.map((value) => value.token)).toEqual(["refresh-access", "refresh-access"]);
    expect(p.counts().refreshCount).toBe(1);
    expect(await getSessionById(result.sessionId, db)).not.toBeNull();
  }, 10000);
  it("never adopts another Coder account during refresh or retries an abandoned rotating grant", async () => {
    const p = provider(),
      result = await p.finish(await p.start());
    await expireAccess(result.user.id);
    p.wrongRefreshOwner();
    await expect(
      getUsableCoderCredential(result.user.id, { db, send: p.send as typeof fetch }),
    ).rejects.toThrow("coder_oauth_reconnect");
    const token = await db.coderToken.findUniqueOrThrow({ where: { userId: result.user.id } });
    expect(token.oauthRefreshState).toBe("reconnect");
    expect(decrypt(token, key)).toBe("access-1");
    expect((await db.user.findUniqueOrThrow({ where: { id: result.user.id } })).coderUserId).toBe(
      p.identity.id,
    );
    await expect(
      getUsableCoderCredential(result.user.id, { db, send: p.send as typeof fetch }),
    ).rejects.toThrow("coder_oauth_reconnect");
    expect(p.counts().refreshCount).toBe(1);
    expect(await getSessionById(result.sessionId, db)).toBeNull();
  });
  it("stale in-flight refresh cannot replace a newer successful sign-in or its sessions", async () => {
    const p = provider(),
      first = await p.finish(await p.start());
    await expireAccess(first.user.id);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((done) => {
        enter = done;
      }),
      released = new Promise<void>((done) => {
        release = done;
      });
    const send: typeof fetch = async (input, init) => {
      if (
        String(input) === `${origin}/oauth2/tokens` &&
        new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token"
      ) {
        enter();
        await released;
      }
      return p.send(input, init);
    };
    const pending = getUsableCoderCredential(first.user.id, { db, send });
    void pending.catch(() => {});
    await entered;
    const second = await p.finish(await p.start());
    release();
    await expect(pending).rejects.toThrow("coder_oauth_reconnect");
    expect(second.user.id).toBe(first.user.id);
    const token = await db.coderToken.findUniqueOrThrow({ where: { userId: first.user.id } });
    expect(decrypt(token, key)).toBe("access-2");
    expect(token.version).toBe(2);
    expect(token.oauthRefreshState).toBe("idle");
    expect(await db.session.count({ where: { userId: first.user.id } })).toBe(2);
  });
  it("expired refresh lease holds for reconnect without reusing its rotating grant", async () => {
    const p = provider(),
      result = await p.finish(await p.start());
    await expireAccess(result.user.id);
    await db.coderToken.update({
      where: { userId: result.user.id },
      data: {
        oauthRefreshState: "refreshing",
        oauthRefreshHolder: randomUUID(),
        oauthRefreshUntil: new Date(Date.now() - 1),
      },
    });
    await expect(
      getUsableCoderCredential(result.user.id, { db, send: p.send as typeof fetch }),
    ).rejects.toThrow("coder_oauth_reconnect");
    expect(p.counts().refreshCount).toBe(0);
    expect(
      (await db.coderToken.findUniqueOrThrow({ where: { userId: result.user.id } }))
        .oauthRefreshState,
    ).toBe("reconnect");
  });
  it.each([
    "redirect",
    "discovery_endpoint",
    "oversized",
  ])("rejects untrusted or unbounded provider response: %s", async (mode) => {
    const clientId = process.env.HIVE_CODER_OAUTH_CLIENT_ID;
    const send: typeof fetch = async () =>
      mode === "redirect"
        ? new Response(null, { status: 307, headers: { location: "https://evil.invalid/steal" } })
        : Response.json(
            mode === "oversized"
              ? { padding: "x".repeat(20000) }
              : {
                  issuer: origin,
                  authorization_endpoint: "https://evil.invalid/authorize",
                  token_endpoint: `${origin}/oauth2/tokens`,
                  code_challenge_methods_supported: ["S256"],
                  token_endpoint_auth_methods_supported: ["client_secret_basic"],
                  response_types_supported: ["code"],
                },
          );
    await expect(startCoderOAuth({ db, send })).rejects.toThrow("coder_oauth_unavailable");
    expect(await db.coderOAuthFlow.count({ where: { clientId } })).toBe(0);
  });
  it("provider timeout is bounded and does not create a usable flow", async () => {
    const send: typeof fetch = () => new Promise(() => {});
    await expect(startCoderOAuth({ db, send, signal: AbortSignal.timeout(20) })).rejects.toThrow(
      "coder_oauth_unavailable",
    );
  });
  it("late credential/session write rolls back after the one-use flow expires", async () => {
    const p = provider(),
      flow = await p.start(),
      stateHash = createHash("sha256")
        .update(new URL(flow.authorizationUrl).searchParams.get("state")!)
        .digest("hex");
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role=replica`;
      await tx.coderOAuthFlow.update({
        where: { stateHash },
        data: { createdAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 100) },
      });
    });
    const send: typeof fetch = async (input, init) => {
      if (String(input) === `${origin}/oauth2/tokens`)
        await new Promise((done) => setTimeout(done, 180));
      return p.send(input, init);
    };
    await expect(
      completeCoderOAuth(
        {
          state: new URL(flow.authorizationUrl).searchParams.get("state")!,
          browserSecret: flow.browserSecret,
          code: "fixture-code",
        },
        { db, send },
      ),
    ).rejects.toThrow("coder_oauth_flow_invalid");
    expect(
      await db.user.findUnique({
        where: { coderUrl_coderUserId: { coderUrl: origin, coderUserId: p.identity.id } },
      }),
    ).toBeNull();
  });
  it("expiry during consume SQL prevents code redemption before any token endpoint call", async () => {
    const p = provider(),
      flow = await p.start(),
      stateHash = createHash("sha256")
        .update(new URL(flow.authorizationUrl).searchParams.get("state")!)
        .digest("hex"),
      name = `oauth_consume_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.35); RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} AFTER UPDATE ON coder_oauth_flows FOR EACH ROW WHEN(NEW.state_hash='${stateHash}' AND NEW.consumed_at IS NOT NULL) EXECUTE FUNCTION ${name}()`,
    );
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role=replica`;
        await tx.coderOAuthFlow.update({
          where: { stateHash },
          data: { createdAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 200) },
        });
      });
      await expect(p.finish(flow)).rejects.toThrow("coder_oauth_flow_invalid");
      expect(p.counts().codeCount).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON coder_oauth_flows`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
  });
});
