import { describe, expect, it, vi } from "vitest";

const deleteKey = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("./managed-keys.js", () => ({ deleteManagedCoderKey: deleteKey }));

import {
  CredentialCASConflict,
  discardRolledBackKey,
  storeLoginCredential,
} from "./credential-store";

const credential = {
  ciphertext: new Uint8Array([1]),
  iv: new Uint8Array([2]),
  authTag: new Uint8Array([3]),
  expiresAt: new Date("2030-01-01"),
  remoteKeyId: "newhivekey",
};
function database() {
  const tx = {
    coderToken: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    session: { create: vi.fn() },
  };
  return {
    tx,
    $transaction: vi.fn((run: (tx: unknown) => unknown) => run(tx)),
    coderToken: tx.coderToken,
  };
}

describe("credential/session transaction", () => {
  it("creates first credential and session inside the same Serializable transaction", async () => {
    const db = database();
    const stored = await storeLoginCredential(db as never, "owner", credential);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(db.tx.coderToken.create).toHaveBeenCalledWith({
      data: { userId: "owner", ...credential },
    });
    expect(db.tx.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "owner", sessionId: stored.sessionId }),
    });
    expect(stored.previousRemoteKeyId).toBeNull();
  });
  it("losing existing-token CAS never creates a session or overwrites the winner", async () => {
    const db = database();
    db.tx.coderToken.findUnique.mockResolvedValue({
      id: "row",
      version: 4,
      remoteKeyId: "priorhive1",
    });
    db.tx.coderToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(storeLoginCredential(db as never, "owner", credential)).rejects.toThrow(
      "Credential write conflict",
    );
    expect(db.tx.coderToken.updateMany).toHaveBeenCalledWith({
      where: { id: "row", version: 4 },
      data: { ...credential, version: { increment: 1 } },
    });
    expect(db.tx.session.create).not.toHaveBeenCalled();
  });
  it("concurrent first insert conflict does not create a session", async () => {
    const db = database();
    db.tx.coderToken.create.mockRejectedValue(new Error("unique conflict"));
    await expect(storeLoginCredential(db as never, "owner", credential)).rejects.toThrow(
      "unique conflict",
    );
    expect(db.tx.session.create).not.toHaveBeenCalled();
  });
  it.each([
    "newhivekey",
    "oldcommitted",
    "unavailable",
  ])("retains ambiguous candidate even when a snapshot would show %s", async (currentId) => {
    deleteKey.mockClear();
    const db = database();
    db.coderToken.findUnique.mockResolvedValue({ remoteKeyId: currentId });
    const candidate = {
      id: "newhivekey",
      token: "synthetic-token",
      expiresAt: new Date("2030-01-01"),
    };
    await discardRolledBackKey(
      "https://coder.example.com",
      "coder-user",
      candidate,
      new Error("unknown commit response"),
    );
    expect(deleteKey).not.toHaveBeenCalled();
    expect(db.coderToken.findUnique).not.toHaveBeenCalled();
  });
  it.each([
    "P2034",
    "P2002",
  ])("only a conclusive Prisma %s rollback authorizes own-key cleanup", async (code) => {
    deleteKey.mockClear();
    const candidate = {
      id: "newhivekey",
      token: "synthetic-token",
      expiresAt: new Date("2030-01-01"),
    };
    await discardRolledBackKey("https://coder.example.com", "coder-user", candidate, {
      name: "PrismaClientKnownRequestError",
      code,
      clientVersion: "6.19.3",
    });
    expect(deleteKey).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      candidate.token,
      "coder-user",
      candidate.id,
    );
  });
  it("an explicit local zero-count CAS rollback allows only its candidate cleanup", async () => {
    deleteKey.mockClear();
    const candidate = {
      id: "newhivekey",
      token: "synthetic-token",
      expiresAt: new Date("2030-01-01"),
    };
    await discardRolledBackKey(
      "https://coder.example.com",
      "coder-user",
      candidate,
      new CredentialCASConflict(),
    );
    expect(deleteKey).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      candidate.token,
      "coder-user",
      candidate.id,
    );
  });
});
