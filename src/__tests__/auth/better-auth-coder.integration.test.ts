import { createHash, randomUUID } from "node:crypto";
import { encrypt } from "@hive/auth";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { createDatabaseRequest } from "../../../packages/db/src/request-scope";
import { createCoderAuth } from "../../../services/auth/src/auth/better-auth";
import { getUsableCoderCredential } from "../../../services/auth/src/auth/coder-oauth-credentials";
import { disconnectCoderOAuth } from "../../../services/auth/src/auth/coder-oauth-disconnect";
import { performLogin } from "../../../services/auth/src/auth/login";
import { getSessionById } from "../../../services/auth/src/auth/session";
import {
  getDecryptedCoderToken,
  getTokenStatus,
} from "../../../services/auth/src/auth/token-status";

const url = process.env.HIVE_BETTER_AUTH_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).port !== "55439" ||
    new URL(url).pathname !== "/hive_better_auth_20261114")
)
  throw Error("Dedicated local Better Auth database required");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_better_auth_20261114",
});
const coderOrigin = "https://coder.oauth.invalid";
const publicOrigin = "https://hive.oauth.invalid";
beforeAll(() => {
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
  vi.stubEnv("CODER_URL", coderOrigin);
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", publicOrigin);
  vi.stubEnv("CODER_OAUTH_CLIENT_ID", "fixture-client");
  vi.stubEnv("CODER_OAUTH_CLIENT_SECRET", "fixture-client-secret");
  vi.stubEnv("COOKIE_SECRET", "fixture-secret-".repeat(4));
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("CODER_CA_CERT", "");
  vi.stubEnv("ALLOWED_CODER_URLS", coderOrigin);
});
beforeEach(async () => {
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
  if (url) await db.$executeRawUnsafe("TRUNCATE users,better_auth_verifications CASCADE");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await db.$disconnect();
  vi.unstubAllEnvs();
});

function fixture() {
  const coderUserId = randomUUID();
  let challenge = "",
    access = "fixture-access-1",
    refresh = "fixture-refresh-1";
  let refreshes = 0;
  let revoked = false;
  let loseRefreshAck = false;
  let rejectClient = false;
  let afterRefresh: (() => Promise<void>) | undefined;
  const send = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = new URL(input);
    expect(request.origin).toBe(coderOrigin);
    expect(init?.redirect).toBe("manual");
    if (request.pathname === "/oauth2/tokens") {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Basic ${Buffer.from("fixture-client:fixture-client-secret").toString("base64")}`,
      );
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code") {
        expect(form.get("redirect_uri")).toBe(`${publicOrigin}/api/auth/callback/coder`);
        expect(
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(challenge);
      } else {
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe(refresh);
        if (rejectClient) return Response.json({ error: "invalid_client" }, { status: 401 });
        refreshes++;
        access = `fixture-access-${refreshes + 1}`;
        refresh = `fixture-refresh-${refreshes + 1}`;
        await afterRefresh?.();
        if (loseRefreshAck) throw Error("Synthetic lost provider response");
      }
      return Response.json({
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 120,
        scope: "coder:all",
      });
    }
    if (request.pathname === "/api/v2/users/me") {
      if (revoked || new Headers(init?.headers).get("Authorization") !== `Bearer ${access}`)
        return Response.json({}, { status: 401 });
      return Response.json({
        id: coderUserId,
        username: "oauth-fixture",
        email: "oauth-fixture@example.invalid",
        status: "active",
      });
    }
    if (request.pathname === "/oauth2/revoke") {
      expect(new URLSearchParams(String(init?.body)).get("token")).toBe(access);
      revoked = true;
      return new Response(null, { status: 200 });
    }
    throw Error("Unexpected provider path");
  });
  async function signIn() {
    const auth = createCoderAuth(db, { send });
    const start = await auth.handler(
      new Request(`${publicOrigin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { Origin: publicOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "coder",
          callbackURL: "/workspaces",
          disableRedirect: true,
        }),
      }),
    );
    expect(start.status).toBe(200);
    const authorization = new URL((await start.json()).url);
    expect(authorization.origin).toBe(coderOrigin);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    challenge = authorization.searchParams.get("code_challenge") ?? "";
    const state = authorization.searchParams.get("state");
    const cookie = start.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const callback = await createCoderAuth(db, { send }).handler(
      new Request(`${publicOrigin}/api/auth/callback/coder?code=fixture-code&state=${state}`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("Location")!, publicOrigin).href).toBe(
      `${publicOrigin}/workspaces`,
    );
    const browserCookie = callback.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const session = await createCoderAuth(db, { send }).api.getSession({
      headers: new Headers({ Cookie: browserCookie }),
    });
    expect(session).not.toBeNull();
    return { session: session!, browserCookie };
  }
  return {
    send,
    signIn,
    coderUserId,
    refreshes: () => refreshes,
    revoke: () => {
      revoked = true;
    },
    loseRefreshAck: () => {
      loseRefreshAck = true;
    },
    rejectClient: (reject: boolean) => {
      rejectClient = reject;
    },
    afterRefresh: (callback: () => Promise<void>) => {
      afterRefresh = callback;
    },
  };
}

function passwordProvider(coderUserId: string) {
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const target = new URL(String(input));
    expect(target.origin).toBe(coderOrigin);
    if (target.pathname === "/api/v2/buildinfo") return Response.json({ version: "2.38.4" });
    if (target.pathname === "/api/v2/users/login")
      return Response.json({ session_token: "fixture-password-session" });
    expect(new Headers(init?.headers).get("Coder-Session-Token")).toBe("fixture-password-session");
    if (target.pathname === "/api/v2/users/me")
      return Response.json({ id: coderUserId, username: "password-fixture" });
    if (target.pathname === "/api/v2/applications/host")
      return Response.json({ host: "*.apps.fixture.invalid" });
    if (target.pathname === `/api/v2/users/${coderUserId}/keys`)
      return Response.json({ key: "fixture-legacy-key" });
    throw Error("Unexpected legacy provider path");
  });
  vi.stubGlobal("fetch", send);
  return send;
}

describe.skipIf(!url)("Better Auth Coder OAuth / actual PostgreSQL", () => {
  it.each([
    false,
    true,
  ])("atomically selects legacy credentials after flag-off password login for disconnected=%s", async (disconnected) => {
    const f = fixture();
    const original = await f.signIn();
    if (disconnected) {
      f.revoke();
      await expect(
        getUsableCoderCredential(original.session.user.id, { db, send: f.send }),
      ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
    }
    const accountBefore = await db.coderOAuthAccount.findFirstOrThrow({
      where: { userId: original.session.user.id },
    });
    const oauthCalls = f.send.mock.calls.length;
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
    const provider = passwordProvider(f.coderUserId);
    const requestDb = createDatabaseRequest(() => db);
    const login = await requestDb.run(async () => {
      const result = await performLogin(
        coderOrigin,
        "oauth-fixture@example.invalid",
        "fixture-password",
      );
      expect(result.user.id).toBe(original.session.user.id);
      expect((await getSessionById(result.sessionId))?.user.id).toBe(result.user.id);
      expect(await getTokenStatus(result.user.id)).toMatchObject({ status: "valid" });
      expect(await getDecryptedCoderToken(result.user.id)).toMatchObject({
        token: "fixture-legacy-key",
      });
      const client = await getCoderClientForUser(result.user.id);
      expect(client.getCredentialSource()).toBe("legacy");
      expect(client.getSessionToken()).toBe("fixture-legacy-key");
      return result;
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: login.user.id } })).authMode).toBe(
      "legacy",
    );
    expect(
      await db.session.count({ where: { userId: login.user.id, authToken: { not: null } } }),
    ).toBe(0);
    expect(
      await db.coderOAuthAccount.findUniqueOrThrow({ where: { id: accountBefore.id } }),
    ).toEqual(accountBefore);
    expect(f.send.mock.calls.length).toBe(oauthCalls);
    expect(provider).toHaveBeenCalledTimes(5);
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
    expect(await requestDb.run(() => getSessionById(login.sessionId))).toBeNull();
    expect(
      await createCoderAuth(db, { send: f.send }).api.getSession({
        headers: new Headers({ Cookie: original.browserCookie }),
      }),
    ).toBeNull();
  });

  it.each([
    "coder_tokens",
    "sessions",
  ])("retains the previous mode, token and sessions when legacy login fails writing %s", async (table) => {
    const f = fixture();
    const original = await f.signIn();
    const encrypted = encrypt("retained-legacy-key", "a".repeat(64));
    await db.coderToken.create({
      data: {
        userId: original.session.user.id,
        ciphertext: new Uint8Array(encrypted.ciphertext),
        iv: new Uint8Array(encrypted.iv),
        authTag: new Uint8Array(encrypted.authTag),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const userBefore = await db.user.findUniqueOrThrow({ where: { id: original.session.user.id } });
    const tokenBefore = await db.coderToken.findUniqueOrThrow({ where: { userId: userBefore.id } });
    const sessionsBefore = await db.session.findMany({
      where: { userId: userBefore.id },
      orderBy: { id: "asc" },
    });
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
    passwordProvider(f.coderUserId);
    await db.$executeRawUnsafe(
      "CREATE FUNCTION oauth_legacy_login_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture legacy login rollback'; END $$",
    );
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER oauth_legacy_login_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION oauth_legacy_login_failure()`,
      );
      const requestDb = createDatabaseRequest(() => db);
      await expect(
        requestDb.run(() =>
          performLogin(coderOrigin, "oauth-fixture@example.invalid", "fixture-password"),
        ),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS oauth_legacy_login_failure ON ${table}`);
      await db.$executeRawUnsafe("DROP FUNCTION oauth_legacy_login_failure()");
    }
    expect(await db.user.findUniqueOrThrow({ where: { id: userBefore.id } })).toEqual(userBefore);
    expect(await db.coderToken.findUniqueOrThrow({ where: { userId: userBefore.id } })).toEqual(
      tokenBefore,
    );
    expect(
      await db.session.findMany({ where: { userId: userBefore.id }, orderBy: { id: "asc" } }),
    ).toEqual(sessionsBefore);
  });

  it("completes the framework's PKCE callback and persists encrypted OAuth credentials with a public UUID session", async () => {
    const f = fixture();
    const { session, browserCookie } = await f.signIn();
    expect(session.session.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(session.session.token).not.toBe(session.session.sessionId);
    expect(browserCookie).toContain("__Host-hive-auth=");
    const user = await db.user.findUniqueOrThrow({ where: { id: session.user.id } });
    expect(user).toMatchObject({
      coderUrl: coderOrigin,
      coderUserId: f.coderUserId,
      authMode: "oauth",
    });
    const account = await db.coderOAuthAccount.findUniqueOrThrow({
      where: { userId_providerId: { userId: user.id, providerId: "coder" } },
    });
    expect(account.accessToken).not.toContain("fixture-access");
    expect(account.refreshToken).not.toContain("fixture-refresh");
    expect(await getUsableCoderCredential(user.id, { db, send: f.send })).toMatchObject({
      token: "fixture-access-1",
      credentialSource: "oauth",
      coderUrl: coderOrigin,
    });
  });
  it("serializes concurrent expiry refresh and preserves the same Hive identity on reconnect", async () => {
    const f = fixture();
    const first = await f.signIn();
    await db.coderOAuthAccount.updateMany({
      where: { userId: first.session.user.id },
      data: { accessTokenExpiresAt: new Date(0) },
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        getUsableCoderCredential(first.session.user.id, { db, send: f.send }),
      ),
    );
    expect(results.map((value) => value.token)).toEqual(Array(3).fill("fixture-access-2"));
    expect(f.refreshes()).toBe(1);
    const next = await f.signIn();
    expect(next.session.user.id).toBe(first.session.user.id);
  });
  it("invalidates sessions after a definitive provider revocation", async () => {
    const f = fixture();
    const { session } = await f.signIn();
    f.revoke();
    await expect(
      getUsableCoderCredential(session.user.id, { db, send: f.send }),
    ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
    expect(await db.session.count({ where: { userId: session.user.id } })).toBe(0);
  });
  it("keeps a legacy identity created after the migration and distinguishes a same-email Coder origin", async () => {
    const f = fixture();
    const email = "oauth-fixture@example.invalid";
    const foreign = await db.user.create({
      data: {
        coderUrl: "https://another-coder.invalid",
        coderUserId: randomUUID(),
        username: "foreign",
        email,
      },
    });
    const user = await db.user.create({
      data: {
        coderUrl: coderOrigin,
        coderUserId: f.coderUserId,
        username: "legacy",
        email,
        terminalControlsBeyondMobile: true,
      },
    });
    const legacySession = await db.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 60000) },
    });
    const { session } = await f.signIn();
    expect(session.user.id).toBe(user.id);
    expect(session.user.id).not.toBe(foreign.id);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).terminalControlsBeyondMobile,
    ).toBe(true);
    expect(await db.session.findUnique({ where: { id: legacySession.id } })).toBeNull();
  });
  it("does not replay an uncertain consumed refresh and requires reconnect", async () => {
    const f = fixture();
    const { session } = await f.signIn();
    await db.coderOAuthAccount.updateMany({
      where: { userId: session.user.id },
      data: { accessTokenExpiresAt: new Date(0) },
    });
    f.loseRefreshAck();
    await expect(
      getUsableCoderCredential(session.user.id, { db, send: f.send }),
    ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
    await expect(
      getUsableCoderCredential(session.user.id, { db, send: f.send }),
    ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
    expect(f.refreshes()).toBe(1);
    expect(await db.session.count({ where: { userId: session.user.id } })).toBe(0);
  });
  it("preserves a grant after a definitive client refusal and refreshes when configuration recovers", async () => {
    const f = fixture();
    const { session } = await f.signIn();
    await db.coderOAuthAccount.updateMany({
      where: { userId: session.user.id },
      data: { accessTokenExpiresAt: new Date(0) },
    });
    f.rejectClient(true);
    await expect(
      getUsableCoderCredential(session.user.id, { db, send: f.send }),
    ).rejects.toHaveProperty("code", "coder_oauth_unavailable");
    expect(await db.session.count({ where: { userId: session.user.id } })).toBe(1);
    expect(f.refreshes()).toBe(0);
    f.rejectClient(false);
    expect(await getUsableCoderCredential(session.user.id, { db, send: f.send })).toMatchObject({
      token: "fixture-access-2",
    });
    expect(f.refreshes()).toBe(1);
  });
  it("keeps an uncertain refresh fenced when a callback activation arrives late, then reconnects atomically", async () => {
    const f = fixture();
    const { session } = await f.signIn();
    const captured = await db.coderOAuthAccount.findFirstOrThrow({
      where: { userId: session.user.id },
    });
    await db.coderOAuthAccount.updateMany({
      where: { id: captured.id },
      data: { accessTokenExpiresAt: new Date(0) },
    });
    f.loseRefreshAck();
    await expect(
      getUsableCoderCredential(session.user.id, { db, send: f.send }),
    ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
    const after = createCoderAuth(db, { send: f.send }).options.databaseHooks?.account?.update
      ?.after;
    expect(after).toBeTypeOf("function");
    await expect(after!(captured as never)).rejects.toThrow("coder_oauth_grant_changed");
    await expect(
      getUsableCoderCredential(session.user.id, { db, send: f.send }),
    ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
    expect(f.refreshes()).toBe(1);
    expect(
      (await db.coderOAuthAccount.findUniqueOrThrow({ where: { id: captured.id } })).refreshState,
    ).toBe("reconnect");
    const reconnected = await f.signIn();
    expect(reconnected.session.user.id).toBe(session.user.id);
    expect(await getUsableCoderCredential(session.user.id, { db, send: f.send })).toMatchObject({
      credentialSource: "oauth",
    });
    expect(f.refreshes()).toBe(1);
  });
  it("keeps a newer login when an older credential verification is rejected late", async () => {
    const f = fixture();
    const first = await f.signIn();
    let reject!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delayed = new Promise<Response>((resolve) => {
      reject = resolve;
    });
    let firstRead = true;
    const send: typeof f.send = vi.fn(async (input, init) => {
      if (firstRead && new URL(input).pathname === "/api/v2/users/me") {
        firstRead = false;
        started();
        return delayed;
      }
      return f.send(input, init);
    });
    const verification = getUsableCoderCredential(first.session.user.id, { db, send });
    await ready;
    const newer = await f.signIn();
    reject(Response.json({}, { status: 401 }));
    expect(await verification).toMatchObject({ credentialSource: "oauth" });
    expect(newer.session.user.id).toBe(first.session.user.id);
    expect(await db.session.count({ where: { userId: first.session.user.id } })).toBe(2);
  });
  it("holds a refresh whose durable token write rolls back without redeeming it twice", async () => {
    const f = fixture();
    const { session } = await f.signIn();
    await db.coderOAuthAccount.updateMany({
      where: { userId: session.user.id },
      data: { accessTokenExpiresAt: new Date(0) },
    });
    await db.$executeRawUnsafe(
      "CREATE FUNCTION oauth_fixture_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.access_token IS DISTINCT FROM OLD.access_token THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER oauth_fixture_rollback BEFORE UPDATE ON coder_oauth_accounts FOR EACH ROW EXECUTE FUNCTION oauth_fixture_rollback()",
    );
    try {
      await expect(
        getUsableCoderCredential(session.user.id, { db, send: f.send }),
      ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
      await expect(
        getUsableCoderCredential(session.user.id, { db, send: f.send }),
      ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
      expect(f.refreshes()).toBe(1);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER oauth_fixture_rollback ON coder_oauth_accounts");
      await db.$executeRawUnsafe("DROP FUNCTION oauth_fixture_rollback()");
    }
  });
  it("serializes disconnect after an admitted refresh and revokes the resulting exact grant", async () => {
    const f = fixture();
    const { session } = await f.signIn();
    await db.coderOAuthAccount.updateMany({
      where: { userId: session.user.id },
      data: { accessTokenExpiresAt: new Date(0) },
    });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.afterRefresh(async () => {
      started();
      await paused;
    });
    const refresh = getUsableCoderCredential(session.user.id, { db, send: f.send });
    await ready;
    const disconnect = disconnectCoderOAuth(session.user.id, { db, send: f.send });
    release();
    await refresh;
    expect(await disconnect).toBe(true);
    expect(await db.session.count({ where: { userId: session.user.id } })).toBe(0);
    const account = await db.coderOAuthAccount.findUniqueOrThrow({
      where: { userId_providerId: { userId: session.user.id, providerId: "coder" } },
    });
    expect(account).toMatchObject({
      accessToken: null,
      refreshToken: null,
      refreshState: "reconnect",
    });
    await expect(
      getUsableCoderCredential(session.user.id, { db, send: f.send }),
    ).rejects.toHaveProperty("code", "coder_oauth_reconnect");
  });
});
