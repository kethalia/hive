import { beforeEach, describe, expect, it, vi } from "vitest";

const _mockVapidKeys = {
  findUnique: vi.fn(),
  create: vi.fn(),
};

const mockDb = vi.hoisted(() => ({
  vapidKeys: {
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
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

import { clearVapidCache, getVapidKeys, getVapidPublicKey } from "@/lib/push/vapid";

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
    mockDb.vapidKeys.upsert.mockReset();
    mockGenerateVAPIDKeys.mockReset();
  });

  it("generates and persists keys when DB is empty", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockGenerateVAPIDKeys.mockReturnValue(FAKE_KEYS);
    mockDb.vapidKeys.upsert.mockResolvedValue({ id: 1, ...FAKE_KEYS });

    const keys = await getVapidKeys();

    expect(keys).toEqual(FAKE_KEYS);
    expect(mockDb.vapidKeys.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mockGenerateVAPIDKeys).toHaveBeenCalledOnce();
    expect(mockDb.vapidKeys.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: {},
      create: { id: 1, ...FAKE_KEYS },
    });
  });

  it("returns cached keys on second call without hitting DB", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockGenerateVAPIDKeys.mockReturnValue(FAKE_KEYS);
    mockDb.vapidKeys.upsert.mockResolvedValue({ id: 1, ...FAKE_KEYS });

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
    expect(mockDb.vapidKeys.upsert).not.toHaveBeenCalled();
  });

  it("does not cache partial state on DB failure during upsert", async () => {
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockGenerateVAPIDKeys.mockReturnValue(FAKE_KEYS);
    mockDb.vapidKeys.upsert.mockRejectedValue(new Error("DB connection lost"));

    await expect(getVapidKeys()).rejects.toThrow("DB connection lost");

    clearVapidCache();
    mockDb.vapidKeys.findUnique.mockResolvedValue(null);
    mockDb.vapidKeys.upsert.mockResolvedValue({ id: 1, ...FAKE_KEYS });

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
