import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  user: { upsert: vi.fn() },
  readCurrent: vi.fn(),
  tx: {
    coderToken: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    session: { create: vi.fn() },
  },
  transaction: vi.fn(),
  createKey: vi.fn(),
  deleteKey: vi.fn(),
}));
vi.mock("@hive/db", () => ({
  getDb: () => ({
    user: fixture.user,
    coderToken: { findUnique: fixture.readCurrent },
    $transaction: fixture.transaction,
  }),
}));
vi.mock("./coder-api.js", () => ({
  validateCoderInstance: vi.fn().mockResolvedValue({ valid: true }),
  coderLogin: vi.fn().mockResolvedValue({
    sessionToken: "login-fixture",
    userId: "coder-user",
    username: "user",
    applicationsHost: "",
  }),
}));
vi.mock("./managed-keys.js", () => ({
  createManagedCoderKey: fixture.createKey,
  deleteManagedCoderKey: fixture.deleteKey,
  getCoderCredentialExpiry: vi.fn(),
}));

import { performLogin } from "./login";

const candidate = {
  id: "newhivekey",
  token: "synthetic-new-token",
  expiresAt: new Date("2030-01-01"),
};
const rollback = (code: string) => ({
  name: "PrismaClientKnownRequestError",
  code,
  clientVersion: "6.19.3",
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODER_URL", "https://coder.example.com");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  fixture.user.upsert.mockResolvedValue({ id: "hive-user" });
  fixture.readCurrent.mockResolvedValue({ remoteKeyId: "oldhivekey" });
  fixture.tx.coderToken.findUnique.mockResolvedValue({
    id: "row",
    version: 1,
    remoteKeyId: "oldhivekey",
  });
  fixture.tx.coderToken.updateMany.mockResolvedValue({ count: 1 });
  fixture.createKey.mockResolvedValue(candidate);
  fixture.deleteKey.mockResolvedValue(true);
  fixture.transaction.mockImplementation((run: (tx: unknown) => Promise<unknown>) =>
    run(fixture.tx),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("actual login storage outcome handling", () => {
  it("retains an ambiguous pending commit even if a separate snapshot would still show the old row", async () => {
    let storedKeyId = "oldhivekey";
    const liveKeys = new Set([storedKeyId, candidate.id]);
    fixture.readCurrent.mockImplementation(async () => ({ remoteKeyId: storedKeyId }));
    fixture.deleteKey.mockImplementation(async (_url, _token, _user, id) => liveKeys.delete(id));
    fixture.transaction.mockImplementationOnce(async (run: (tx: unknown) => Promise<unknown>) => {
      await run(fixture.tx);
      // The callback's writes were accepted, but commit acknowledgement is lost.
      // A concurrent read may still expose the old committed row at this point.
      throw new Error("Commit response lost");
    });
    await expect(performLogin("fixture@example.com", "fixture-password")).rejects.toThrow(
      "Commit response lost",
    );
    expect(fixture.deleteKey).not.toHaveBeenCalled();
    expect(fixture.readCurrent).not.toHaveBeenCalled();
    storedKeyId = candidate.id; // The delayed commit becomes visible after the failed request.
    expect(liveKeys.has(storedKeyId)).toBe(true);
    expect(fixture.deleteKey).not.toHaveBeenCalled();
  });
  it.each([
    "P2034",
    "P2002",
  ])("a conclusive %s transaction rollback may discard only this attempt's new key", async (code) => {
    fixture.transaction.mockRejectedValueOnce(rollback(code));
    await expect(performLogin("fixture@example.com", "fixture-password")).rejects.toMatchObject({
      code,
    });
    expect(fixture.deleteKey).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      candidate.token,
      "coder-user",
      candidate.id,
    );
    expect(fixture.readCurrent).not.toHaveBeenCalled();
  });
  it("explicit zero-count CAS rollback never revokes the winner or prior key", async () => {
    fixture.tx.coderToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(performLogin("fixture@example.com", "fixture-password")).rejects.toThrow(
      "Credential write conflict",
    );
    expect(fixture.tx.session.create).not.toHaveBeenCalled();
    expect(fixture.deleteKey).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      candidate.token,
      "coder-user",
      candidate.id,
    );
  });
});
