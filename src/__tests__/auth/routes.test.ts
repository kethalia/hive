import { signCookie } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockServiceClient = vi.hoisted(() => ({
  getSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

const mockCookieStore = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockHeaderStore = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockCheckRateLimit = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mockCookieStore),
  headers: vi.fn(() => mockHeaderStore),
}));

vi.mock("@/lib/auth/service-client", () => ({
  getAuthServiceClient: () => mockServiceClient,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  loginRateLimiter: {
    check: (...args: unknown[]) => mockCheckRateLimit(...args),
  },
}));

import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";

function getSetCookies(response: Response): string[] {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  return (
    getSetCookie?.call(response.headers) ??
    (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") ?? ""] : [])
  );
}

describe("auth route cookies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");
    mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 4, resetMs: 60000 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("login sets a domain cookie and clears the stale host-only cookie", async () => {
    mockServiceClient.login.mockResolvedValue({ sessionId: "sess-123" });

    const response = await loginPOST(
      new Request("https://hive.local.kethalia.com/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({
          coderUrl: "https://coder.example.com",
          email: "test@example.com",
          password: "pass123",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("1.2.3.4");
    expect(mockServiceClient.login).toHaveBeenCalledWith({
      coderUrl: "https://coder.example.com",
      email: "test@example.com",
      password: "pass123",
    });

    const setCookies = getSetCookies(response);
    expect(setCookies).toHaveLength(3);
    expect(setCookies[0]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[0]).not.toContain("Domain=");
    expect(setCookies[1]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[1]).toContain("Domain=.hive.local.kethalia.com");
    expect(setCookies[2]).toContain("hive-session=sess-123.");
    expect(setCookies[2]).toContain("Domain=.hive.local.kethalia.com");
    expect(setCookies[2]).toContain("HttpOnly");
    expect(setCookies[2]).toContain("SameSite=Lax");
  });

  it("login derives a preview-scoped cookie domain when COOKIE_DOMAIN is unset", async () => {
    vi.stubEnv("COOKIE_DOMAIN", "");
    mockServiceClient.login.mockResolvedValue({ sessionId: "sess-preview" });

    const response = await loginPOST(
      new Request("https://pr-113.hive.local.kethalia.com/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({
          coderUrl: "https://coder.example.com",
          email: "test@example.com",
          password: "pass123",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const setCookies = getSetCookies(response);
    expect(setCookies).toHaveLength(4);
    expect(setCookies[0]).not.toContain("Domain=");
    expect(setCookies[1]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[1]).toContain("Domain=.pr-113.hive.local.kethalia.com");
    expect(setCookies[2]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[2]).toContain("Domain=.hive.local.kethalia.com");
    expect(setCookies[3]).toContain("hive-session=sess-preview.");
    expect(setCookies[3]).toContain("Domain=.pr-113.hive.local.kethalia.com");
  });

  it("login rejects invalid input without calling auth service", async () => {
    const response = await loginPOST(
      new Request("https://hive.local.kethalia.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coderUrl: "https://coder.example.com",
          email: "not-an-email",
          password: "pass123",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockServiceClient.login).not.toHaveBeenCalled();
    expect(getSetCookies(response)).toEqual([]);
  });

  it("login rejects rate-limited requests without calling auth service", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0, resetMs: 60000 });

    const response = await loginPOST(
      new Request("https://hive.local.kethalia.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coderUrl: "https://coder.example.com",
          email: "test@example.com",
          password: "pass123",
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(mockServiceClient.login).not.toHaveBeenCalled();
    expect(getSetCookies(response)).toEqual([]);
  });

  it("login returns an error without setting cookies when auth service rejects credentials", async () => {
    mockServiceClient.login.mockRejectedValue(new Error("invalid credentials"));

    const response = await loginPOST(
      new Request("https://hive.local.kethalia.com/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coderUrl: "https://coder.example.com",
          email: "test@example.com",
          password: "wrong",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid credentials" });
    expect(getSetCookies(response)).toEqual([]);
  });

  it("logout clears both domain and host-only cookies", async () => {
    const signedCookie = signCookie("sess-123", "test-secret");
    mockCookieStore.get.mockReturnValue({ value: signedCookie });
    mockServiceClient.getSession.mockResolvedValue({
      userId: "u1",
      coderUserId: "coder-u1",
      username: "testuser",
      email: "test@example.com",
      coderUrl: "https://coder.example.com",
      sessionId: "sess-123",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    mockServiceClient.logout.mockResolvedValue(undefined);

    const response = await logoutPOST(
      new Request("https://hive.local.kethalia.com/api/auth/logout", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockServiceClient.logout).toHaveBeenCalledWith("sess-123");

    const setCookies = getSetCookies(response);
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[0]).toContain("Domain=.hive.local.kethalia.com");
    expect(setCookies[1]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[1]).not.toContain("Domain=");
    expect(setCookies.join("\n")).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("preview logout clears preview and parent domain cookies when COOKIE_DOMAIN is unset", async () => {
    vi.stubEnv("COOKIE_DOMAIN", "");
    const signedCookie = signCookie("sess-preview", "test-secret");
    mockCookieStore.get.mockReturnValue({ value: signedCookie });
    mockServiceClient.getSession.mockResolvedValue({
      userId: "u1",
      coderUserId: "coder-u1",
      username: "testuser",
      email: "test@example.com",
      coderUrl: "https://coder.example.com",
      sessionId: "sess-preview",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    mockServiceClient.logout.mockResolvedValue(undefined);

    const response = await logoutPOST(
      new Request("https://pr-113.hive.local.kethalia.com/api/auth/logout", { method: "POST" }),
    );

    expect(response.status).toBe(200);

    const setCookies = getSetCookies(response);
    expect(setCookies).toHaveLength(3);
    expect(setCookies[0]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[0]).toContain("Domain=.pr-113.hive.local.kethalia.com");
    expect(setCookies[1]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[1]).toContain("Domain=.hive.local.kethalia.com");
    expect(setCookies[2]).toContain("hive-session=; Path=/; Max-Age=0");
    expect(setCookies[2]).not.toContain("Domain=");
  });
});
