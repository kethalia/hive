import { createHash, randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@hive/auth";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeCoderOAuth,
  startCoderOAuth,
} from "../../../../services/auth/src/auth/coder-oauth";
import { getUsableCoderCredential } from "../../../../services/auth/src/auth/coder-oauth-credentials";
import { getSessionById } from "../../../../services/auth/src/auth/session";

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
afterEach(() => vi.unstubAllEnvs());
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
