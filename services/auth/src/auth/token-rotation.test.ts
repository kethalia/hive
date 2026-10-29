import { encrypt } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn() }));
vi.mock("./managed-keys.js", () => ({
  createManagedCoderKey: keys.create,
  deleteManagedCoderKey: keys.remove,
}));

import { rotateCoderCredentials } from "./token-rotation";

const now = Date.parse("2026-10-29T12:00:00Z");
const day = 86400000;
const candidate = {
  id: "newhivekey",
  token: "synthetic-new-token",
  expiresAt: new Date(now + 30 * day),
};
function token(overrides: Record<string, unknown> = {}) {
  return {
    id: "row",
    userId: "owner",
    version: 4,
    remoteKeyId: "oldhivekey",
    ...encrypt("synthetic-old-token", "a".repeat(64)),
    createdAt: new Date(now - 29 * day),
    updatedAt: new Date(now - 29 * day),
    expiresAt: new Date(now + day),
    user: { coderUrl: "https://coder.example.com", coderUserId: "coder-user" },
    ...overrides,
  };
}
function fixture(rows = [token()]) {
  const db = {
    coderToken: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
  };
  return {
    db,
    run: (options = {}) => rotateCoderCredentials({ db: db as never, now, ...options }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODER_URL", "https://coder.example.com");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  keys.create.mockResolvedValue(candidate);
  keys.remove.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("portable token rotation provenance", () => {
  it("commits actual expiry and managed ID under CAS, then revokes only tracked prior key", async () => {
    const { db, run } = fixture();
    expect((await run()).rotated).toBe(1);
    expect(db.coderToken.updateMany).toHaveBeenCalledWith({
      where: { id: "row", version: 4 },
      data: expect.objectContaining({
        remoteKeyId: candidate.id,
        expiresAt: candidate.expiresAt,
        version: { increment: 1 },
      }),
    });
    expect(keys.remove).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      candidate.token,
      "coder-user",
      "oldhivekey",
    );
    expect(db.coderToken.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      keys.remove.mock.invocationCallOrder[0],
    );
  });
  it("a losing CAS deletes only its newly-created key, preserving winner and unrelated keys", async () => {
    const { db, run } = fixture();
    db.coderToken.updateMany.mockResolvedValue({ count: 0 });
    expect((await run()).conflicts).toBe(1);
    expect(keys.remove).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      candidate.token,
      "coder-user",
      candidate.id,
    );
  });
  it("legacy NULL ownership retains the prior key", async () => {
    const { run } = fixture([token({ remoteKeyId: null })]);
    expect((await run()).legacyKeysRetained).toBe(1);
    expect(keys.remove).not.toHaveBeenCalled();
  });
  it.each([
    candidate.id,
    "winnerkey1",
    "oldhivekey",
    "unavailable",
  ])("protects ambiguous write outcome when DB currently holds %s", async (currentId) => {
    const { db, run } = fixture();
    db.coderToken.updateMany.mockRejectedValue(new Error("lost commit response"));
    if (currentId === "unavailable")
      db.coderToken.findUnique.mockRejectedValue(new Error("unavailable"));
    else db.coderToken.findUnique.mockResolvedValue({ remoteKeyId: currentId });
    expect((await run()).failed).toBe(1);
    expect(keys.remove).not.toHaveBeenCalled();
    expect(db.coderToken.findUnique).not.toHaveBeenCalled();
  });
  it("does not rotate expired, wrong-origin, early or undecryptable credentials", async () => {
    const { run } = fixture([
      token({ expiresAt: new Date(now - 1) }),
      token({ user: { coderUrl: "https://other.example.com", coderUserId: "other" } }),
      token({ updatedAt: new Date(now), expiresAt: new Date(now + 30 * day) }),
      token({ ciphertext: new Uint8Array([0]) }),
    ]);
    expect((await run()).skipped).toBe(4);
    expect(keys.create).not.toHaveBeenCalled();
  });
  it("calculates the 75% threshold using a shorter actual provider lifetime", async () => {
    const { run } = fixture([
      token({ updatedAt: new Date(now - day * 0.8), expiresAt: new Date(now + day * 0.2) }),
    ]);
    expect((await run()).rotated).toBe(1);
  });
  it("failed push does not prevent rotation and failed mint leaves current key intact", async () => {
    const { run, db } = fixture();
    const notifyExpiring = vi.fn().mockRejectedValue(new Error("unavailable"));
    expect((await run({ notifyExpiring })).rotated).toBe(1);
    expect(notifyExpiring).toHaveBeenCalledWith("owner", 24);
    keys.remove.mockClear();
    db.coderToken.updateMany.mockClear();
    keys.create.mockResolvedValue(null);
    expect((await run()).failed).toBe(1);
    expect(db.coderToken.updateMany).not.toHaveBeenCalled();
    expect(keys.remove).not.toHaveBeenCalled();
  });
  it("bounds each page and exposes the cursor for a scheduler", async () => {
    const { db, run } = fixture([token({ id: "a" }), token({ id: "b" })]);
    expect((await run({ batchSize: 2, afterId: "previous" })).nextCursor).toBe("b");
    expect(db.coderToken.findMany).toHaveBeenCalledWith({
      where: { id: { gt: "previous" } },
      include: { user: true },
      orderBy: { id: "asc" },
      take: 2,
    });
    await expect(run({ batchSize: 101 })).rejects.toThrow("batch size");
  });
});
