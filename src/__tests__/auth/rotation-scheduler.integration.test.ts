import { randomUUID } from "node:crypto";
import { encrypt, tryDecrypt } from "@hive/auth";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchTokenWarnings } from "@/lib/auth/rotation-notices";
import { runCredentialRotation } from "../../../services/auth/src/auth/rotation-scheduler";
import { CredentialRotationStore } from "../../../services/auth/src/auth/rotation-store";

// This suite owns its scratch database and truncates synthetic auth fixtures.
// It must never share the delivery schema-25 proof database or a preview database.
const url = process.env.HIVE_ROTATION_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/hive_rotation_test"
  )
    throw new Error("Dedicated local rotation fixture required");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_rotation_test",
});
const origin = "https://rotation.example.invalid";
const encryptionKey = "a".repeat(64);
const day = 86400_000;
const candidate = (id = "abcdefghij") => ({
  id,
  token: `${id}-${"k".repeat(22)}`,
  expiresAt: new Date(Date.now() + 30 * day),
});
async function token(index = 1, eligible = true) {
  const user = await db.user.create({
    data: {
      coderUrl: origin,
      coderUserId: randomUUID(),
      username: `fixture-${randomUUID()}`,
      email: "rotation@example.invalid",
    },
  });
  const encrypted = encrypt("private-fixture-credential", encryptionKey);
  return db.coderToken.create({
    data: {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      userId: user.id,
      ciphertext: new Uint8Array(encrypted.ciphertext),
      iv: new Uint8Array(encrypted.iv),
      authTag: new Uint8Array(encrypted.authTag),
      remoteKeyId: "oldhivekey",
      createdAt: new Date(Date.now() - 29 * day),
      updatedAt: new Date(Date.now() - (eligible ? 29 : 1) * day),
      expiresAt: new Date(Date.now() + (eligible ? 1 : 29) * day),
    },
    include: { user: true },
  });
}
function runner(extra: Partial<Parameters<typeof runCredentialRotation>[0]> = {}) {
  const createKey = vi.fn().mockResolvedValue(candidate()),
    deleteKey = vi.fn().mockResolvedValue(true);
  return {
    createKey,
    deleteKey,
    run: () => runCredentialRotation({ enabled: true, db, createKey, deleteKey, ...extra }),
  };
}
async function rewind() {
  await db.$executeRaw`UPDATE credential_rotation_schedules SET after_id=NULL,next_run_at=clock_timestamp(),holder=NULL,lease_until=NULL`;
}
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  if (!url) return;
  vi.stubEnv("CODER_URL", origin);
  vi.stubEnv("ENCRYPTION_KEY", encryptionKey);
  vi.stubEnv("CODER_CA_CERT", "");
  await db.$executeRaw`TRUNCATE credential_expiry_notices,credential_rotation_operations,credential_rotation_schedules,coder_tokens,users CASCADE`;
});
describe.skipIf(!url)("auth rotation durable scheduler, dedicated local PostgreSQL", () => {
  it("concurrent wake-ups mint once and atomically persist verified provenance before prior-key cleanup", async () => {
    const old = await token(),
      f = runner();
    const results = await Promise.all([f.run(), f.run()]);
    expect(results.filter((r) => "claimed" in r && r.claimed)).toHaveLength(1);
    expect(f.createKey).toHaveBeenCalledTimes(1);
    expect(f.deleteKey).toHaveBeenCalledWith(
      origin,
      candidate().token,
      old.user.coderUserId,
      "oldhivekey",
      expect.any(AbortSignal),
    );
    const current = await db.coderToken.findUniqueOrThrow({ where: { id: old.id } });
    expect(current).toMatchObject({ version: 2, remoteKeyId: "abcdefghij" });
    expect(
      tryDecrypt(
        {
          ciphertext: Buffer.from(current.ciphertext),
          iv: Buffer.from(current.iv),
          authTag: Buffer.from(current.authTag),
        },
        encryptionKey,
      ),
    ).toEqual({ ok: true, plaintext: candidate().token });
    expect(await db.$queryRaw`SELECT phase FROM credential_rotation_operations`).toEqual([
      { phase: "stored" },
    ]);
    await expect(
      db.$executeRaw`UPDATE credential_rotation_operations SET phase='minting',finished_at=NULL,reason=NULL,remote_key_id=NULL`,
    ).rejects.toThrow();
  });
  it("persists the fair scan cursor across process replacement and stops at the row and mint budgets", async () => {
    for (let i = 1; i <= 23; i++) await token(i, i > 20);
    const first = runner();
    expect(await first.run()).toMatchObject({ scanned: 20, minted: 0 });
    expect(await runner().run()).toMatchObject({ scanned: 2, minted: 2, rotated: 2 });
    expect(await runner().run()).toMatchObject({ scanned: 1, minted: 1, rotated: 1 });
    expect(await runner().run()).toMatchObject({ claimed: false });
    expect(
      await db.$queryRaw`SELECT after_id,next_run_at>clock_timestamp() AS waiting FROM credential_rotation_schedules`,
    ).toEqual([{ after_id: null, waiting: true }]);
  });
  it("crash reservation and expired lease never authorize another mint for that credential generation", async () => {
    const row = await token(),
      store = new CredentialRotationStore(db),
      claim = await store.claim(origin);
    expect(claim).not.toBeNull();
    await store.prepare(claim!, row, {
      mint: true,
      notify: true,
      expiresAt: row.expiresAt!.getTime(),
    });
    await db.$executeRaw`UPDATE credential_rotation_schedules SET lease_until=clock_timestamp()-interval '1 second'`;
    const restarted = runner();
    expect(await restarted.run()).toMatchObject({ minted: 0, held: 1 });
    expect(restarted.createKey).not.toHaveBeenCalled();
    expect(await db.$queryRaw`SELECT phase FROM credential_rotation_operations`).toEqual([
      { phase: "minting" },
    ]);
    await expect(db.$executeRaw`DELETE FROM credential_rotation_operations`).rejects.toThrow();
  });
  it("lease takeover while Coder is in flight holds the generation and rejects the old writer CAS", async () => {
    await token();
    let finish: (value: ReturnType<typeof candidate>) => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const createKey = vi.fn().mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const old = runner({ createKey }),
      pending = old.run();
    await started;
    await db.$executeRaw`UPDATE credential_rotation_schedules SET lease_until=clock_timestamp()-interval '1 second'`;
    const next = runner();
    expect(await next.run()).toMatchObject({ minted: 0, held: 1 });
    finish(candidate());
    await expect(pending).rejects.toThrow("rotation_lease_lost");
    expect(next.createKey).not.toHaveBeenCalled();
    expect(old.deleteKey.mock.calls[0][3]).toBe("abcdefghij");
    expect((await db.coderToken.findFirstOrThrow()).version).toBe(1);
    expect(await db.$queryRaw`SELECT phase FROM credential_rotation_operations`).toEqual([
      { phase: "not_stored" },
    ]);
  });
  it.each([
    false,
    true,
  ])("unknown database write outcome retains candidate even when commit actually happened=%s", async (committed) => {
    await token();
    class AmbiguousStore extends CredentialRotationStore {
      override async commit(...args: Parameters<CredentialRotationStore["commit"]>) {
        if (committed) await super.commit(...args);
        throw new Error("private lost commit acknowledgement");
      }
    }
    const f = runner({ store: new AmbiguousStore(db) });
    expect(await f.run()).toMatchObject({ held: 1, rotated: 0 });
    expect(f.deleteKey).not.toHaveBeenCalled();
    expect((await db.coderToken.findFirstOrThrow()).version).toBe(committed ? 2 : 1);
    expect(await db.$queryRaw`SELECT phase FROM credential_rotation_operations`).toEqual([
      { phase: committed ? "stored" : "uncertain" },
    ]);
    await rewind();
    const later = runner();
    await later.run();
    expect(later.createKey).not.toHaveBeenCalled();
  });
  it("a concurrent login wins CAS without losing its key or any untracked legacy key", async () => {
    const row = await token();
    const f = runner({
      createKey: async () => {
        await db.coderToken.update({
          where: { id: row.id },
          data: { version: { increment: 1 }, remoteKeyId: "loginwin01" },
        });
        return candidate();
      },
    });
    expect(await f.run()).toMatchObject({ held: 1, rotated: 0 });
    expect(f.deleteKey.mock.calls.map((c) => c[3])).toEqual(["abcdefghij"]);
    expect((await db.coderToken.findUniqueOrThrow({ where: { id: row.id } })).remoteKeyId).toBe(
      "loginwin01",
    );
  });
  it("origin mutation before commit rejects persistence and deletes only its own known rolled-back candidate", async () => {
    const row = await token();
    const f = runner({
      createKey: async () => {
        await db.user.update({
          where: { id: row.userId },
          data: { coderUrl: "https://other.example.invalid" },
        });
        return candidate();
      },
    });
    expect(await f.run()).toMatchObject({ held: 1, rotated: 0 });
    expect(f.deleteKey.mock.calls.map((c) => c[3])).toEqual(["abcdefghij"]);
    expect((await db.coderToken.findUniqueOrThrow({ where: { id: row.id } })).version).toBe(1);
  });
  it("warnings survive failed mint but successful replacement suppresses obsolete token-version notices", async () => {
    await token();
    await runner({ createKey: async () => null }).run();
    const failing = vi.fn().mockRejectedValue(new Error("private push error"));
    expect(await dispatchTokenWarnings(db, failing)).toMatchObject({ retry: 1 });
    expect(failing.mock.calls[0][1]).toMatchObject({ kind: "token", url: "/login" });
    await db.$executeRaw`UPDATE credential_expiry_notices SET next_attempt_at=clock_timestamp()`;
    await db.coderToken.updateMany({ data: { version: { increment: 1 } } });
    const send = vi.fn();
    expect(await dispatchTokenWarnings(db, send)).toMatchObject({ skipped: 1 });
    expect(send).not.toHaveBeenCalled();
  });
  it("notice owner FK and late delivery acknowledgement cannot cross ownership or claim generations", async () => {
    const row = await token();
    await runner({ createKey: async () => null }).run();
    const other = await db.user.create({
      data: {
        coderUrl: origin,
        coderUserId: randomUUID(),
        username: "other",
        email: "other@example.invalid",
      },
    });
    await expect(
      db.$executeRaw`UPDATE credential_expiry_notices SET owner_id=${other.id}::uuid`,
    ).rejects.toThrow();
    let sent = 0;
    expect(
      await dispatchTokenWarnings(db, async () => {
        if (sent++ === 0)
          await db.$executeRaw`UPDATE credential_expiry_notices SET next_attempt_at=clock_timestamp()-interval '1 second'`;
        return "delivered";
      }),
    ).toMatchObject({ stale: 1 });
    expect((await db.coderToken.findUniqueOrThrow({ where: { id: row.id } })).version).toBe(1);
  });
  it("warning retries are bounded and a crash on the last claim cannot cause a sixth provider attempt", async () => {
    await token();
    await runner({ createKey: async () => null }).run();
    const send = vi.fn().mockResolvedValue("retry");
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await dispatchTokenWarnings(db, send)).toMatchObject({ retry: 1 });
      await db.$executeRaw`UPDATE credential_expiry_notices SET next_attempt_at=clock_timestamp()`;
    }
    // A terminated invocation had already consumed attempt five. Lease expiry
    // retires it as failed instead of resetting its fence or resending forever.
    await db.$executeRaw`UPDATE credential_expiry_notices SET attempts=5,status='processing',next_attempt_at=clock_timestamp()-interval '1 second'`;
    await dispatchTokenWarnings(db, send);
    expect(send).toHaveBeenCalledTimes(4);
    expect(await db.$queryRaw`SELECT status,attempts FROM credential_expiry_notices`).toEqual([
      { status: "failed", attempts: 5 },
    ]);
  });
});
