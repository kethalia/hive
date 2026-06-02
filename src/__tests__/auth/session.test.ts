import { beforeEach, describe, expect, it, vi } from "vitest";

const mockServiceClient = vi.hoisted(() => ({
  getSession: vi.fn(),
  logout: vi.fn(),
}));

const mockVerifyCookie = vi.hoisted(() => vi.fn());
const mockSignCookie = vi.hoisted(() => vi.fn());

vi.mock("@hive/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/auth")>()),
  verifyCookie: (...args: unknown[]) => mockVerifyCookie(...args),
  signCookie: (...args: unknown[]) => mockSignCookie(...args),
}));

vi.mock("@/lib/auth/service-client", () => ({
  getAuthServiceClient: () => mockServiceClient,
}));

import {
  clearSessionCookie,
  deleteSession,
  getSession,
  setSessionCookie,
} from "@/lib/auth/session";

describe("session management", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    process.env.COOKIE_SECRET = "test-secret";
  });

  describe("getSession", () => {
    it("returns null when no cookie present", async () => {
      const cookieStore = { get: vi.fn().mockReturnValue(undefined) };
      const result = await getSession(cookieStore);
      expect(result).toBeNull();
      expect(mockVerifyCookie).not.toHaveBeenCalled();
    });

    it("returns null when verifyCookie returns null (tampered cookie)", async () => {
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "tampered-cookie" }),
      };
      mockVerifyCookie.mockReturnValue(null);

      const result = await getSession(cookieStore);

      expect(result).toBeNull();
      expect(mockVerifyCookie).toHaveBeenCalledWith("tampered-cookie", "test-secret");
      expect(mockServiceClient.getSession).not.toHaveBeenCalled();
    });

    it("returns null when auth service returns null (session not found)", async () => {
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "signed-cookie" }),
      };
      mockVerifyCookie.mockReturnValue({ sessionId: "sess-123" });
      mockServiceClient.getSession.mockResolvedValue(null);

      const result = await getSession(cookieStore);

      expect(result).toBeNull();
      expect(mockServiceClient.getSession).toHaveBeenCalledWith("sess-123");
    });

    it("returns null when auth service throws", async () => {
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "signed-cookie" }),
      };
      mockVerifyCookie.mockReturnValue({ sessionId: "sess-123" });
      mockServiceClient.getSession.mockRejectedValue(new Error("network error"));

      const result = await getSession(cookieStore);

      expect(result).toBeNull();
    });

    it("returns correctly mapped SessionData for valid session", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "signed-cookie" }),
      };
      mockVerifyCookie.mockReturnValue({ sessionId: "sess-123" });
      mockServiceClient.getSession.mockResolvedValue({
        userId: "user-1",
        coderUserId: "coder-user-1",
        username: "testuser",
        email: "test@example.com",
        coderUrl: "https://coder.example.com",
        sessionId: "sess-123",
        expiresAt: futureDate.toISOString(),
      });

      const result = await getSession(cookieStore);

      expect(result).not.toBeNull();
      expect(result!.user).toEqual({
        id: "user-1",
        coderUrl: "https://coder.example.com",
        coderUserId: "coder-user-1",
        username: "testuser",
        email: "test@example.com",
      });
      expect(result!.session.sessionId).toBe("sess-123");
      expect(result!.session.id).toBe("sess-123");
      expect(result!.session.expiresAt).toBeInstanceOf(Date);
    });

    it("uses the valid scoped cookie when duplicate session cookies include a stale parent-domain cookie", async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const cookieStore = {
        get: vi.fn().mockReturnValue({ value: "prod-cookie" }),
        getAll: vi.fn().mockReturnValue([{ value: "prod-cookie" }, { value: "preview-cookie" }]),
      };
      mockVerifyCookie.mockImplementation((value) =>
        value === "preview-cookie" ? { sessionId: "sess-preview" } : null,
      );
      mockServiceClient.getSession.mockResolvedValue({
        userId: "user-1",
        coderUserId: "coder-user-1",
        username: "testuser",
        email: "test@example.com",
        coderUrl: "https://coder.example.com",
        sessionId: "sess-preview",
        expiresAt: futureDate.toISOString(),
      });

      const result = await getSession(cookieStore);

      expect(result).not.toBeNull();
      expect(result!.session.sessionId).toBe("sess-preview");
      expect(mockVerifyCookie).toHaveBeenCalledWith("prod-cookie", "test-secret");
      expect(mockVerifyCookie).toHaveBeenCalledWith("preview-cookie", "test-secret");
      expect(mockServiceClient.getSession).toHaveBeenCalledWith("sess-preview");
    });
  });

  describe("deleteSession", () => {
    it("calls AuthServiceClient.logout()", async () => {
      mockServiceClient.logout.mockResolvedValue(undefined);

      await deleteSession("sess-to-delete");

      expect(mockServiceClient.logout).toHaveBeenCalledWith("sess-to-delete");
    });

    it("handles auth service error gracefully", async () => {
      mockServiceClient.logout.mockRejectedValue(new Error("service down"));

      await expect(deleteSession("sess-123")).resolves.toBeUndefined();
    });
  });

  describe("setSessionCookie", () => {
    it("signs and sets HttpOnly, SameSite=Lax, 30-day maxAge cookie", () => {
      const cookieStore = { set: vi.fn() };
      mockSignCookie.mockReturnValue("signed-value");

      setSessionCookie(cookieStore, "my-session-id");

      expect(mockSignCookie).toHaveBeenCalledWith("my-session-id", "test-secret");
      expect(cookieStore.set).toHaveBeenCalledWith("hive-session", "signed-value", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
    });

    it("sets Secure flag in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      const cookieStore = { set: vi.fn() };
      mockSignCookie.mockReturnValue("signed-value");
      setSessionCookie(cookieStore, "my-session-id");

      const options = cookieStore.set.mock.calls[0][2] as Record<string, unknown>;
      expect(options.secure).toBe(true);

      vi.unstubAllEnvs();
    });

    it("includes domain when COOKIE_DOMAIN is set", () => {
      vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");

      const cookieStore = { set: vi.fn() };
      mockSignCookie.mockReturnValue("signed-value");
      setSessionCookie(cookieStore, "my-session-id");

      expect(cookieStore.set).toHaveBeenCalledWith("hive-session", "signed-value", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
        domain: ".hive.local.kethalia.com",
      });

      vi.unstubAllEnvs();
    });

    it("refuses broad parent COOKIE_DOMAIN values", () => {
      vi.stubEnv("COOKIE_DOMAIN", ".kethalia.com");
      vi.spyOn(console, "error").mockImplementation(() => {});

      const cookieStore = { set: vi.fn() };
      mockSignCookie.mockReturnValue("signed-value");
      setSessionCookie(cookieStore, "my-session-id");

      const options = cookieStore.set.mock.calls[0][2] as Record<string, unknown>;
      expect(options).not.toHaveProperty("domain");
      expect(console.error).toHaveBeenCalledWith(
        "[session-cookie] Refusing unsafe COOKIE_DOMAIN; use a Hive-specific parent such as .hive.local.kethalia.com",
      );

      vi.unstubAllEnvs();
    });

    it("omits domain when COOKIE_DOMAIN is not set", () => {
      const cookieStore = { set: vi.fn() };
      mockSignCookie.mockReturnValue("signed-value");
      setSessionCookie(cookieStore, "my-session-id");

      const options = cookieStore.set.mock.calls[0][2] as Record<string, unknown>;
      expect(options).not.toHaveProperty("domain");
    });
  });

  describe("clearSessionCookie", () => {
    it("sets cookie with maxAge 0", () => {
      const cookieStore = { set: vi.fn() };

      clearSessionCookie(cookieStore);

      expect(cookieStore.set).toHaveBeenCalledWith(
        "hive-session",
        "",
        expect.objectContaining({ maxAge: 0 }),
      );
    });

    it("clears both domain and host-only cookies when COOKIE_DOMAIN is set", () => {
      vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");

      const cookieStore = { set: vi.fn() };
      clearSessionCookie(cookieStore);

      expect(cookieStore.set).toHaveBeenNthCalledWith(
        1,
        "hive-session",
        "",
        expect.not.objectContaining({ domain: expect.anything() }),
      );
      expect(cookieStore.set).toHaveBeenNthCalledWith(
        2,
        "hive-session",
        "",
        expect.objectContaining({ maxAge: 0, domain: ".hive.local.kethalia.com" }),
      );

      vi.unstubAllEnvs();
    });

    it("omits domain when COOKIE_DOMAIN is not set", () => {
      const cookieStore = { set: vi.fn() };
      clearSessionCookie(cookieStore);

      const options = cookieStore.set.mock.calls[0][2] as Record<string, unknown>;
      expect(options).not.toHaveProperty("domain");
    });
  });
});
