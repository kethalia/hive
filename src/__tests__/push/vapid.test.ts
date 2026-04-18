import { describe, it, expect, vi, beforeEach } from "vitest";

const mockVapidKeys = {
  findUnique: vi.fn(),
  create: vi.fn(),
};

const mockDb = vi.hoisted(() => ({
  vapidKeys: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => mockDb,
}));

const mockGenerateVAPIDKeys = vi.hoisted(() => vi.fn());

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: (...args: unknown[]) => mockGenerateVAPIDKeys(...args),
  },
}));

import { getVapidKeys, getVapidPublicKey, clearVapidCache } from "@/lib/push/vapid";

describe("getVapidKeys", () => {
  const FAKE_KEYS = {
    publicKey: "BPubKey123",
    privateKey: "PrivKey456",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearVapidCache();
    mockDb.vapidKeys.findUnique.mockReset();
    mockDb.vapidKeys.create.mockReset();
    mockGenerateVAPIDKeys.mockReset();
  });

  it("generates and persists keys when DB is empty", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockGenerateVAPIDKeys.mockReturnValue(FAKE_KEYS);
    mockDb.vapidKeys.create.mockResolvedValue({ id: 1, ...FAKE_KEYS });

    const keys = await getVapidKeys();

    expect(keys).toEqual(FAKE_KEYS);
    expect(mockDb.vapidKeys.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mockGenerateVAPIDKeys).toHaveBeenCalledOnce();
    expect(mockDb.vapidKeys.create).toHaveBeenCalledWith({
      data: { id: 1, ...FAKE_KEYS },
    });
  });

  it("returns cached keys on second call without hitting DB", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockGenerateVAPIDKeys.mockReturnValue(FAKE_KEYS);
    mockDb.vapidKeys.create.mockResolvedValue({ id: 1, ...FAKE_KEYS });

    await getVapidKeys();
    const keys = await getVapidKeys();

    expect(keys).toEqual(FAKE_KEYS);
    expect(mockDb.vapidKeys.findUnique).toHaveBeenCalledTimes(1);
  });

  it("returns existing keys from DB without generating", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue({
      id: 1,
      ...FAKE_KEYS,
      createdAt: new Date(),
    });

    const keys = await getVapidKeys();

    expect(keys).toEqual(FAKE_KEYS);
    expect(mockGenerateVAPIDKeys).not.toHaveBeenCalled();
    expect(mockDb.vapidKeys.create).not.toHaveBeenCalled();
  });

  it("does not cache partial state on DB failure during create", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockGenerateVAPIDKeys.mockReturnValue(FAKE_KEYS);
    mockDb.vapidKeys.create.mockRejectedValue(new Error("DB connection lost"));

    await expect(getVapidKeys()).rejects.toThrow("DB connection lost");

    clearVapidCache();
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockDb.vapidKeys.create.mockResolvedValue({ id: 1, ...FAKE_KEYS });

    const keys = await getVapidKeys();
    expect(keys).toEqual(FAKE_KEYS);
  });

  it("does not cache partial state on DB failure during find", async () => {
    mockDb.vapidKeys.findUnique.mockRejectedValue(new Error("DB unreachable"));

    await expect(getVapidKeys()).rejects.toThrow("DB unreachable");

    mockDb.vapidKeys.findUnique.mockResolvedValue({ id: 1, ...FAKE_KEYS, createdAt: new Date() });
    clearVapidCache();

    const keys = await getVapidKeys();
    expect(keys).toEqual(FAKE_KEYS);
  });
});

describe("getVapidPublicKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVapidCache();
    mockDb.vapidKeys.findUnique.mockReset();
  });

  it("returns only the public key", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue({
      id: 1,
      publicKey: "BPubKey123",
      privateKey: "PrivKey456",
      createdAt: new Date(),
    });

    const pubKey = await getVapidPublicKey();
    expect(pubKey).toBe("BPubKey123");
  });
});
