import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  user: {
    upsert: vi.fn(),
  },
  coderToken: {
    upsert: vi.fn(),
  },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

const { mockCreateSession, mockEncrypt, mockValidateInstance, mockLogin, mockCreateApiKey } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockEncrypt: vi.fn(),
  mockValidateInstance: vi.fn(),
  mockLogin: vi.fn(),
  mockCreateApiKey: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
}));

vi.mock("@/lib/auth/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
}));

vi.mock("@/lib/coder/client", () => ({
  CoderClient: {
    validateInstance: (...args: unknown[]) => mockValidateInstance(...args),
    login: (...args: unknown[]) => mockLogin(...args),
    createApiKey: (...args: unknown[]) => mockCreateApiKey(...args),
  },
}));

import { performLogin } from "@/lib/auth/login";

describe("performLogin", () => {
  const TEST_ENCRYPTION_KEY = "a".repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    mockEncrypt.mockReturnValue({
      ciphertext: Buffer.from("encrypted"),
      iv: Buffer.from("iv123456789a"),
      authTag: Buffer.from("authtag1234567aa"),
    });

    mockPrisma.user.upsert.mockResolvedValue({
      id: "db-user-id",
      coderUrl: "https://coder.example.com",
      coderUserId: "coder-uid",
      username: "testuser",
      email: "test@example.com",
    });

    mockPrisma.coderToken.upsert.mockResolvedValue({});
    mockCreateSession.mockResolvedValue("new-session-id");
  });

  it("succeeds with API key creation", async () => {
    mockValidateInstance.mockResolvedValue({ valid: true, version: "2.8.0" });
    mockLogin.mockResolvedValue({
      sessionToken: "session-token-123",
      userId: "coder-uid",
      username: "testuser",
    });
    mockCreateApiKey.mockResolvedValue("api-key-xyz");

    const result = await performLogin(
      "https://coder.example.com",
      "test@example.com",
      "password123"
    );

    expect(result.sessionId).toBe("new-session-id");
    expect(result.user.username).toBe("testuser");
    expect(mockCreateApiKey).toHaveBeenCalledTimes(1);
    expect(mockEncrypt).toHaveBeenCalledWith("api-key-xyz", TEST_ENCRYPTION_KEY);
    expect(mockPrisma.user.upsert).toHaveBeenCalled();
    expect(mockPrisma.coderToken.upsert).toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith("db-user-id");
  });

  it("falls back to session token when API key creation fails all 3 retries", async () => {
    mockValidateInstance.mockResolvedValue({ valid: true, version: "2.8.0" });
    mockLogin.mockResolvedValue({
      sessionToken: "session-token-123",
      userId: "coder-uid",
      username: "testuser",
    });
    mockCreateApiKey.mockResolvedValue(null);

    const result = await performLogin(
      "https://coder.example.com",
      "test@example.com",
      "password123"
    );

    expect(result.sessionId).toBe("new-session-id");
    expect(mockCreateApiKey).toHaveBeenCalledTimes(3);
    expect(mockEncrypt).toHaveBeenCalledWith(
      "session-token-123",
      TEST_ENCRYPTION_KEY
    );
  });

  it("rejects invalid Coder URL", async () => {
    mockValidateInstance.mockResolvedValue({
      valid: false,
      reason: "DNS resolution failed",
    });

    await expect(
      performLogin("https://invalid.example.com", "a@b.com", "pass")
    ).rejects.toThrow("Invalid Coder instance: DNS resolution failed");

    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("rejects invalid credentials", async () => {
    mockValidateInstance.mockResolvedValue({ valid: true, version: "2.8.0" });
    mockLogin.mockRejectedValue(new Error("invalid credentials"));

    await expect(
      performLogin("https://coder.example.com", "a@b.com", "wrong")
    ).rejects.toThrow("invalid credentials");

    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it("throws when TOKEN_ENCRYPTION_KEY is not set", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;

    mockValidateInstance.mockResolvedValue({ valid: true, version: "2.8.0" });
    mockLogin.mockResolvedValue({
      sessionToken: "session-token-123",
      userId: "coder-uid",
      username: "testuser",
    });
    mockCreateApiKey.mockResolvedValue("api-key-xyz");

    await expect(
      performLogin("https://coder.example.com", "a@b.com", "pass")
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY environment variable is not set");
  });

  it("succeeds on second API key retry", async () => {
    mockValidateInstance.mockResolvedValue({ valid: true, version: "2.8.0" });
    mockLogin.mockResolvedValue({
      sessionToken: "session-token-123",
      userId: "coder-uid",
      username: "testuser",
    });
    mockCreateApiKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("api-key-retry");

    const result = await performLogin(
      "https://coder.example.com",
      "test@example.com",
      "password123"
    );

    expect(result.sessionId).toBe("new-session-id");
    expect(mockCreateApiKey).toHaveBeenCalledTimes(2);
    expect(mockEncrypt).toHaveBeenCalledWith(
      "api-key-retry",
      TEST_ENCRYPTION_KEY
    );
  });

  it("strips trailing slash from coderUrl in user upsert", async () => {
    mockValidateInstance.mockResolvedValue({ valid: true, version: "2.8.0" });
    mockLogin.mockResolvedValue({
      sessionToken: "st",
      userId: "coder-uid",
      username: "testuser",
    });
    mockCreateApiKey.mockResolvedValue("key");

    await performLogin(
      "https://coder.example.com/",
      "test@example.com",
      "pass"
    );

    const upsertCall = mockPrisma.user.upsert.mock.calls[0][0];
    expect(upsertCall.where.coderUrl_coderUserId.coderUrl).toBe(
      "https://coder.example.com"
    );
    expect(upsertCall.create.coderUrl).toBe("https://coder.example.com");
  });
});
