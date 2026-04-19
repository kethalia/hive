import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  session: {
    create: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => mockPrisma,
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: vi.fn(() => "test-session-uuid-1234"),
  };
});

import {
  createSession,
  getSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
} from "@/lib/auth/session";

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

  describe("getSession", () => {
    it("returns null when no cookie present", async () => {
      const cookieStore = { get: vi.fn().mockReturnValue(undefined) };
      const result = await getSession(cookieStore);
      expect(result).toBeNull();
    });

    it("returns null for non-existent sessionId", async () => {
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "nonexistent-id" }),
      };
      mockPrisma.session.findUnique.mockResolvedValue(null);

      const result = await getSession(cookieStore);
      expect(result).toBeNull();
    });

    it("returns null and deletes expired session", async () => {
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "expired-session" }),
      };
      const pastDate = new Date(Date.now() - 1000);
      mockPrisma.session.findUnique.mockResolvedValue({
        id: "db-id",
        sessionId: "expired-session",
        expiresAt: pastDate,
        user: {
          id: "user-1",
          coderUrl: "https://coder.example.com",
          coderUserId: "coder-uid",
          username: "testuser",
          email: "test@example.com",
        },
      });
      mockPrisma.session.delete.mockResolvedValue({});

      const result = await getSession(cookieStore);

      expect(result).toBeNull();
      expect(mockPrisma.session.delete).toHaveBeenCalledWith({
        where: { sessionId: "expired-session" },
      });
    });

    it("returns session data for valid session", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "valid-session" }),
      };
      mockPrisma.session.findUnique.mockResolvedValue({
        id: "db-id",
        sessionId: "valid-session",
        expiresAt: futureDate,
        user: {
          id: "user-1",
          coderUrl: "https://coder.example.com",
          coderUserId: "coder-uid",
          username: "testuser",
          email: "test@example.com",
        },
      });

      const result = await getSession(cookieStore);

      expect(result).not.toBeNull();
      expect(result!.user.id).toBe("user-1");
      expect(result!.user.username).toBe("testuser");
      expect(result!.session.sessionId).toBe("valid-session");
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

  describe("setSessionCookie", () => {
    it("sets HttpOnly, SameSite=Lax, 30-day maxAge cookie", () => {
      const cookieStore = { set: vi.fn() };

      setSessionCookie(cookieStore, "my-session-id");

      expect(cookieStore.set).toHaveBeenCalledWith(
        "hive-session",
        "my-session-id",
        {
          httpOnly: true,
          secure: false,
          sameSite: "lax",
          path: "/",
          maxAge: 30 * 24 * 60 * 60,
        }
      );
    });

    it("sets Secure flag in production", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const cookieStore = { set: vi.fn() };
      setSessionCookie(cookieStore, "my-session-id");

      const options = cookieStore.set.mock.calls[0][2] as Record<string, unknown>;
      expect(options.secure).toBe(true);

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("clearSessionCookie", () => {
    it("sets cookie with maxAge 0", () => {
      const cookieStore = { set: vi.fn() };

      clearSessionCookie(cookieStore);

      expect(cookieStore.set).toHaveBeenCalledWith(
        "hive-session",
        "",
        expect.objectContaining({ maxAge: 0 })
      );
    });
  });
});
