import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { encrypt, tryDecrypt } from "@hive/auth";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchLegacyTokenRotation } from "@/lib/queue/token-rotation-cloudflare.server";

vi.mock("@hive/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/db")>()),
  getDb: () => {
    throw Error("Implicit database access forbidden in rotation fixture");
  },
}));

const url = process.env.HIVE_ROTATION_PARITY_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).pathname !== "/hive_rotation_parity_test_20261113")
)
  throw Error("Owned local rotation fixture required");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_rotation_parity_test_20261113",
});
const loginDb = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_rotation_parity_test_20261113",
});
const origin = "https://coder.rotation.invalid";
const key = "a".repeat(64);
const oldToken = `AAAAAAAAAA-${"A".repeat(22)}`;
const loginToken = `LLLLLLLLLL-${"L".repeat(22)}`;
function encryptedForDb(token: string) {
  const value = encrypt(token, key);
  return {
    ciphertext: Uint8Array.from(value.ciphertext),
    iv: Uint8Array.from(value.iv),
    authTag: Uint8Array.from(value.authTag),
  };
}
const ownedUsers: string[] = [];
beforeAll(() => {
  vi.stubEnv("CODER_URL", origin);
  vi.stubEnv("ENCRYPTION_KEY", key);
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.rotation.invalid");
});
afterAll(async () => {
  if (url) {
    await db.pushSubscription.deleteMany({ where: { userId: { in: ownedUsers } } });
    await db.coderToken.deleteMany({ where: { userId: { in: ownedUsers } } });
    await db.user.deleteMany({ where: { id: { in: ownedUsers } } });
  }
  vi.unstubAllEnvs();
  await Promise.all([db.$disconnect(), loginDb.$disconnect()]);
});
let sequence = 0;
type Key = {
  id: string;
  user_id: string;
  token_name: string;
  login_type: string;
  expires_at: string;
  secret: string;
};
async function fixture(hours = 7 * 24) {
  const ownerId = randomUUID(),
    coderUserId = randomUUID();
  ownedUsers.push(ownerId);
  await db.user.create({
    data: {
      id: ownerId,
      coderUserId,
      coderUrl: origin,
      username: "rotation-fixture",
      email: `${ownerId}@example.invalid`,
    },
  });
  const credential = await db.coderToken.create({
    data: {
      userId: ownerId,
      ...encryptedForDb(oldToken),
      expiresAt: new Date(Date.now() + hours * 3600000),
    },
  });
  const keys = new Map<string, Key>();
  const add = (token: string, tokenName: string, loginType = "token") => {
    const id = token.slice(0, 10);
    keys.set(id, {
      id,
      user_id: coderUserId,
      token_name: tokenName,
      login_type: loginType,
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      secret: token,
    });
  };
  add(oldToken, "", "password");
  add(`BBBBBBBBBB-${"B".repeat(22)}`, "unrelated-integration");
  add(`CCCCCCCCCC-${"C".repeat(22)}`, "interactive-session", "password");
  add(loginToken, "new-login", "password");
  let posts = 0;
  const deleted: string[] = [];
  let afterMint: (() => Promise<void>) | undefined;
  let rejectMint = false;
  let dropBeforeMint = false;
  let foreignOwner = false;
  let loseDelete = false;
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = new URL(input);
    expect(request.origin).toBe(origin);
    expect(init?.redirect).toBe("manual");
    const token = new Headers(init?.headers).get("Coder-Session-Token");
    const active = [...keys.values()].find((item) => item.secret === token);
    if (!active) return Response.json({}, { status: 401 });
    if (request.pathname === "/api/v2/users/me")
      return Response.json({ id: foreignOwner ? randomUUID() : coderUserId });
    expect(request.pathname.startsWith(`/api/v2/users/${coderUserId}/keys/`)).toBe(true);
    const suffix = request.pathname.split("/keys/")[1];
    if (init?.method === "POST") {
      expect(suffix).toBe("tokens");
      const body = JSON.parse(String(init.body));
      expect(body.lifetime).toBe(30 * 86400 * 1000000000);
      expect(body.token_name).toMatch(/^hive-r-[a-f0-9-]{36}$/);
      posts++;
      if (dropBeforeMint) throw Error("synthetic-dropped-before-provider-commit");
      const token = `${String(++sequence).padStart(10, "0")}-${"S".repeat(22)}`;
      add(token, body.token_name);
      await afterMint?.();
      if (rejectMint) throw Error("synthetic-lost-mint-ack");
      return Response.json({ key: token }, { status: 201 });
    }
    if (init?.method === "DELETE") {
      expect(/^[A-Za-z0-9]{10}$/.test(suffix)).toBe(true);
      deleted.push(suffix);
      const exists = keys.delete(suffix);
      if (loseDelete) {
        loseDelete = false;
        throw Error("synthetic-lost-delete-ack");
      }
      return new Response(null, { status: exists ? 204 : 404 });
    }
    const item = suffix.startsWith("tokens/")
      ? [...keys.values()].find((item) => item.token_name === suffix.slice(7))
      : keys.get(suffix);
    return Response.json(item ? { ...item, secret: undefined } : {}, { status: item ? 200 : 404 });
  });
  const sendWarning = vi.fn(async () => "delivered");
  const run = (options: Partial<Parameters<typeof dispatchLegacyTokenRotation>[1]> = {}) =>
    dispatchLegacyTokenRotation(db, {
      ownerId,
      deadline: Date.now() + 25000,
      fetch: fetcher,
      sendWarning,
      ...options,
    });
  const read = () => db.coderToken.findUniqueOrThrow({ where: { id: credential.id } });
  const due = () =>
    db.coderToken.update({
      where: { id: credential.id },
      data: { rotationNextAt: new Date(0), rotationLeaseId: null, rotationLeaseUntil: null },
    });
  return {
    ownerId,
    coderUserId,
    credential,
    keys,
    deleted,
    fetcher,
    sendWarning,
    run,
    read,
    due,
    posts: () => posts,
    loseDeleteAck: () => {
      loseDelete = true;
    },
    afterMint: (callback: () => Promise<void>) => {
      afterMint = callback;
    },
    loseAck: () => {
      rejectMint = true;
    },
    beforeCommitFailure: () => {
      dropBeforeMint = true;
    },
    wrongOwner: () => {
      foreignOwner = true;
    },
  };
}
function decrypt(row: Awaited<ReturnType<typeof db.coderToken.findUniqueOrThrow>>) {
  const result = tryDecrypt(
    {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.authTag),
    },
    key,
  );
  if (!result.ok) throw Error("fixture-decryption-failed");
  return result.plaintext;
}
describe.skipIf(!url)("Cloudflare legacy token rotation / actual PostgreSQL", () => {
  it("rotates with named provenance and retains unrelated and unproven legacy keys", async () => {
    const f = await fixture();
    expect((await f.run()).rotated).toBe(1);
    const row = await f.read();
    expect(row.version).toBe(2);
    const state = row.rotationState as {
      managed: { id: string; name: string; version: number };
      pending: unknown;
    };
    expect(state.pending).toBeNull();
    expect(state.managed.version).toBe(2);
    expect(decrypt(row)).toBe(f.keys.get(state.managed.id)?.secret);
    expect(f.deleted).toEqual([]);
    expect([...f.keys.keys()]).toContain("AAAAAAAAAA");
    expect([...f.keys.keys()]).toEqual(expect.arrayContaining(["BBBBBBBBBB", "CCCCCCCCCC"]));
    const next = await f.run();
    expect(next.checked).toBe(0);
    expect(f.posts()).toBe(1);
  });
  it("deletes only a recorded previous Hive key after the next successful CAS", async () => {
    const f = await fixture();
    await f.run();
    const first = (await f.read()).rotationState as { managed: { id: string } };
    await db.coderToken.update({
      where: { id: f.credential.id },
      data: { expiresAt: new Date(Date.now() + 7 * 86400000), rotationNextAt: new Date(0) },
    });
    expect((await f.run()).rotated).toBe(1);
    expect(f.deleted).toEqual([first.managed.id]);
    expect(f.keys.has("BBBBBBBBBB")).toBe(true);
    expect(f.keys.has("CCCCCCCCCC")).toBe(true);
    expect(f.keys.has("AAAAAAAAAA")).toBe(true);
    expect((await f.read()).version).toBe(3);
  });
  it("serializes concurrent dispatch without duplicate minting", async () => {
    const f = await fixture();
    let release!: () => void, minted!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      minted = resolve;
    });
    f.afterMint(async () => {
      minted();
      await hold;
    });
    const first = f.run();
    await started;
    expect((await f.run()).checked).toBe(0);
    release();
    expect((await first).rotated).toBe(1);
    expect(f.posts()).toBe(1);
  });
  it("holds unknown mint ACK, reconciles only its deterministic named orphan, and never duplicates a mint", async () => {
    const f = await fixture();
    f.loseAck();
    expect((await f.run()).held).toBe(1);
    expect((await f.read()).version).toBe(1);
    expect((await f.read()).rotationState).toMatchObject({ pending: { phase: "minting" } });
    expect(f.posts()).toBe(1);
    const orphan = [...f.keys.values()].find((item) => item.token_name.startsWith("hive-r-"))!;
    await f.due();
    expect((await f.run()).reconciled).toBe(1);
    expect(f.deleted).toEqual([orphan.id]);
    expect(f.posts()).toBe(1);
    expect(decrypt(await f.read())).toBe(oldToken);
    expect(f.keys.has("BBBBBBBBBB")).toBe(true);
  });
  it("replays a durable discard after orphan deletion commits but its ACK is lost", async () => {
    const f = await fixture();
    f.loseAck();
    await f.run();
    f.loseDeleteAck();
    await f.due();
    expect((await f.run()).held).toBe(1);
    expect((await f.read()).rotationState).toMatchObject({ pending: { phase: "discarding" } });
    const deleted = [...f.deleted];
    await f.due();
    expect((await f.run()).reconciled).toBe(1);
    expect(f.deleted).toEqual(deleted);
    expect(f.posts()).toBe(1);
    expect((await f.read()).rotationState).toMatchObject({ pending: null });
    expect(decrypt(await f.read())).toBe(oldToken);
  });

  it("reconciles known old-key deletion after successful CAS and lost cleanup ACK", async () => {
    const f = await fixture();
    await f.run();
    const first = (await f.read()).rotationState as { managed: { id: string } };
    await db.coderToken.update({
      where: { id: f.credential.id },
      data: { expiresAt: new Date(Date.now() + 7 * 86400000), rotationNextAt: new Date(0) },
    });
    f.loseDeleteAck();
    const second = await f.run();
    expect(second.rotated).toBe(1);
    expect(second.held).toBe(1);
    expect((await f.read()).rotationState).toMatchObject({ pending: { phase: "cleanup" } });
    expect(f.deleted).toEqual([first.managed.id]);
    const current = decrypt(await f.read());
    await f.due();
    await f.run();
    expect(f.deleted).toEqual([first.managed.id]);
    expect(f.posts()).toBe(2);
    expect(decrypt(await f.read())).toBe(current);
    expect((await f.read()).rotationState).toMatchObject({ pending: null });
  });

  it("does not remint after an unknown request when named metadata is still absent", async () => {
    const f = await fixture();
    f.beforeCommitFailure();
    expect((await f.run()).held).toBe(1);
    await f.due();
    expect((await f.run()).held).toBe(1);
    expect(f.posts()).toBe(1);
    expect(f.deleted).toEqual([]);
    expect((await f.read()).rotationState).toMatchObject({ pending: { phase: "minting" } });
  });
  it("caps expiry-warning attempts at one per account hour even when minute dispatch repeats", async () => {
    const f = await fixture(12);
    f.beforeCommitFailure();
    expect((await f.run()).warned).toBe(1);
    expect(f.sendWarning).toHaveBeenCalledWith(
      expect.anything(),
      f.ownerId,
      expect.objectContaining({ kind: "token", tag: "token-expiry", url: "/login" }),
      expect.any(AbortSignal),
      expect.any(Number),
    );
    await f.due();
    expect((await f.run()).warned).toBe(0);
    expect(f.sendWarning).toHaveBeenCalledOnce();
  });
  it("uses the locked transaction for actual warning subscriptions/VAPID and honors token preferences", async () => {
    const f = await fixture(12);
    f.beforeCommitFailure();
    const subscriber = createECDH("prime256v1");
    subscriber.generateKeys();
    await db.pushSubscription.create({
      data: {
        userId: f.ownerId,
        endpoint: `https://push.rotation.invalid/${f.ownerId}`,
        p256dh: subscriber.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
        preferences: { token: true },
      },
    });
    const provider = vi.fn(async (input: string | URL | Request) => {
      expect(String(input).startsWith("https://push.rotation.invalid/")).toBe(true);
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", provider);
    try {
      expect((await f.run({ sendWarning: undefined })).warned).toBe(1);
      expect(provider).toHaveBeenCalledOnce();
      expect(await db.vapidKeys.count()).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never creates/deletes a key under a mismatching fresh provider owner", async () => {
    const f = await fixture();
    f.wrongOwner();
    expect((await f.run()).held).toBe(1);
    expect(f.posts()).toBe(0);
    expect(f.deleted).toEqual([]);
  });
  it("rolls back a failed CAS and adopts the same encrypted candidate on retry", async () => {
    const f = await fixture();
    await db.$executeRawUnsafe(
      `CREATE FUNCTION rotation_fixture_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.credential.id}'::uuid AND NEW.version>OLD.version THEN RAISE EXCEPTION 'fixture CAS rollback'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER rotation_fixture_reject BEFORE UPDATE ON coder_tokens FOR EACH ROW EXECUTE FUNCTION rotation_fixture_reject()",
    );
    try {
      const first = await f.run();
      expect(first.rotated).toBe(0);
      expect(first.held).toBe(1);
      expect((await f.read()).version).toBe(1);
      expect((await f.read()).rotationState).toMatchObject({ pending: { phase: "minted" } });
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER rotation_fixture_reject ON coder_tokens");
      await db.$executeRawUnsafe("DROP FUNCTION rotation_fixture_reject()");
    }
    await f.due();
    expect((await f.run()).rotated).toBe(1);
    expect(f.posts()).toBe(1);
  });
  it("losing rotation preserves a newer login and deletes only that losing attempt's minted key", async () => {
    const f = await fixture();
    let replacement: Promise<unknown> | undefined;
    f.afterMint(async () => {
      replacement = loginDb.coderToken.update({
        where: { id: f.credential.id },
        data: {
          ...encryptedForDb(loginToken),
          version: { increment: 1 },
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
      });
      void replacement.catch(() => {});
      for (let i = 0; i < 100; i++) {
        const [waiting] = await db.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM pg_stat_activity WHERE datname='hive_rotation_parity_test_20261113' AND wait_event_type='Lock' AND query LIKE '%UPDATE%coder_tokens%'`;
        if (Number(waiting.count)) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw Error("fixture login did not queue its row lock");
    });
    const result = await f.run();
    await replacement;
    expect(result.rotated).toBe(0);
    expect(result.reconciled).toBe(1);
    expect(decrypt(await f.read())).toBe(loginToken);
    expect(f.deleted).toHaveLength(1);
    expect(f.deleted[0]).not.toBe("LLLLLLLLLL");
    expect(f.keys.has("BBBBBBBBBB")).toBe(true);
    expect(f.keys.has("CCCCCCCCCC")).toBe(true);
  });
  it("bounds owner-selected work and skips healthy/future or expired credentials", async () => {
    const healthy = await fixture(30 * 24),
      expired = await fixture(-1),
      due = await fixture();
    expect((await healthy.run()).checked).toBe(0);
    expect((await expired.run()).checked).toBe(0);
    expect((await due.run()).rotated).toBe(1);
    expect(healthy.fetcher).not.toHaveBeenCalled();
    expect(expired.fetcher).not.toHaveBeenCalled();
    expect((await healthy.read()).version).toBe(1);
  });
  it("cancels a pending provider read and cancels its late response without continuing to mint", async () => {
    const f = await fixture();
    let resolve!: (response: Response) => void, started!: () => void;
    const ready = new Promise<void>((accept) => {
      started = accept;
    });
    const work = new Promise<Response>((accept) => {
      resolve = accept;
    });
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      started();
      return work;
    });
    const dispatch = f.run({ fetch, signal: controller.signal });
    await ready;
    controller.abort();
    expect((await dispatch).held).toBe(1);
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await new Promise((accept) => setTimeout(accept, 5));
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect((await f.read()).version).toBe(1);
  });
});
