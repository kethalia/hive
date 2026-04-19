import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  session: {
    create: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("../db.js", () => ({
  getDb: () => mockPrisma,
}));

vi.mock("node:crypto", async () => {
  const actual =
    await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: vi.fn(() => "test-session-uuid-1234"),
  };
});

import { createSession, getSessionById, deleteSession } from "./session.js";

describe("session management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSession", () => {
    it("generates UUID and inserts row with 30-day expiry", async () => {
      mockPrisma.session.create.mockResolvedValue({
        id: "db-id",
        sessionId: "test-session-uuid-1234",
        userId: "user-1",
        expiresAt: new Date(),
      });

      const sessionId = await createSession("user-1");

      expect(sessionId).toBe("test-session-uuid-1234");
      expect(mockPrisma.session.create).toHaveBeenCalledWith({
        data: {
          sessionId: "test-session-uuid-1234",
          userId: "user-1",
          expiresAt: expect.any(Date),
        },
      });

      const call = mockPrisma.session.create.mock.calls[0][0];
      const expiresAt = call.data.expiresAt as Date;
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const diff = expiresAt.getTime() - Date.now();
      expect(diff).toBeGreaterThan(thirtyDaysMs - 5000);
      expect(diff).toBeLessThanOrEqual(thirtyDaysMs);
    });
  });

  describe("getSessionById", () => {
    it("returns null for non-existent sessionId", async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const result = await getSessionById("nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns null and deletes expired session", async () => {
      const pastDate = new Date(Date.now() - 1000);
      mockPrisma.session.findUnique.mockResolvedValue({
        id: "db-id",
        sessionId: "expired-session",
        expiresAt: pastDate,
        userId: "user-1",
        user: {
          id: "user-1",
          coderUrl: "https://coder.example.com",
          coderUserId: "coder-uid",
          username: "testuser",
          email: "test@example.com",
        },
      });
      mockPrisma.session.delete.mockResolvedValue({});

      const result = await getSessionById("expired-session");

      expect(result).toBeNull();
      expect(mockPrisma.session.delete).toHaveBeenCalledWith({
        where: { sessionId: "expired-session" },
      });
    });

    it("returns session data for valid session", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      mockPrisma.session.findUnique.mockResolvedValue({
        id: "db-id",
        sessionId: "valid-session",
        expiresAt: futureDate,
        userId: "user-1",
        user: {
          id: "user-1",
          coderUrl: "https://coder.example.com",
          coderUserId: "coder-uid",
          username: "testuser",
          email: "test@example.com",
        },
      });

      const result = await getSessionById("valid-session");

      expect(result).not.toBeNull();
      expect(result!.user.id).toBe("user-1");
      expect(result!.user.username).toBe("testuser");
      expect(result!.session.sessionId).toBe("valid-session");
    });

    it("returns null for empty sessionId", async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const result = await getSessionById("");
      expect(result).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("deletes session by sessionId", async () => {
      mockPrisma.session.deleteMany.mockResolvedValue({ count: 1 });

      await deleteSession("session-to-delete");

      expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({
        where: { sessionId: "session-to-delete" },
      });
    });
  });
});
