import { describe, it, expect, vi, beforeEach } from "vitest";

const mockServiceClient = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  getCredentials: vi.fn(),
}));

const mockSetSessionCookie = vi.hoisted(() => vi.fn());
const mockClearSessionCookie = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn());

const mockCookieStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const mockHeaderStore = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mockCookieStore),
  headers: vi.fn(() => mockHeaderStore),
}));

vi.mock("@/lib/auth/service-client", () => ({
  getAuthServiceClient: () => mockServiceClient,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  setSessionCookie: (...args: unknown[]) => mockSetSessionCookie(...args),
  clearSessionCookie: (...args: unknown[]) => mockClearSessionCookie(...args),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  loginRateLimiter: {
    check: (...args: unknown[]) => mockCheckRateLimit(...args),
  },
}));

import {
  loginAction,
  logoutAction,
  getSessionAction,
  getTokenStatusAction,
} from "@/lib/auth/actions";

describe("loginAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaderStore.get.mockImplementation((name: string) => {
      if (name === "x-forwarded-for") return "1.2.3.4";
      return null;
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 4, resetMs: 60000 });
  });

  it("succeeds with valid input", async () => {
    mockServiceClient.login.mockResolvedValue({
      sessionId: "sess-123",
      user: { id: "u1", username: "testuser", email: "test@example.com", coderUrl: "https://coder.example.com" },
    });

    const result = await loginAction({
      coderUrl: "https://coder.example.com",
      email: "test@example.com",
      password: "pass123",
    });

    expect(result?.data).toEqual({ success: true });
    expect(mockServiceClient.login).toHaveBeenCalledWith({
      coderUrl: "https://coder.example.com",
      email: "test@example.com",
      password: "pass123",
    });
    expect(mockSetSessionCookie).toHaveBeenCalledWith(mockCookieStore, "sess-123");
  });

  it("returns error when auth service login fails", async () => {
    mockServiceClient.login.mockRejectedValue(new Error("invalid credentials"));

    const result = await loginAction({
      coderUrl: "https://coder.example.com",
      email: "test@example.com",
      password: "pass123",
    });

    expect(result?.serverError).toBe("invalid credentials");
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects when rate limited", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0, resetMs: 30000 });

    const result = await loginAction({
      coderUrl: "https://coder.example.com",
      email: "test@example.com",
      password: "pass123",
    });

    expect(result?.serverError).toBe("Too many login attempts. Please try again later.");
    expect(mockServiceClient.login).not.toHaveBeenCalled();
  });

  it("rejects invalid input (bad email)", async () => {
    const result = await loginAction({
      coderUrl: "https://coder.example.com",
      email: "not-an-email",
      password: "pass123",
    });

    expect(result?.validationErrors).toBeDefined();
    expect(mockServiceClient.login).not.toHaveBeenCalled();
  });

  it("reads IP from x-forwarded-for header", async () => {
    mockHeaderStore.get.mockImplementation((name: string) => {
      if (name === "x-forwarded-for") return "10.0.0.1, 10.0.0.2";
      return null;
    });
    mockServiceClient.login.mockResolvedValue({ sessionId: "s1", user: {} });

    await loginAction({
      coderUrl: "https://coder.example.com",
      email: "test@example.com",
      password: "pass",
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith("10.0.0.1");
  });
});

describe("logoutAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: "u1", coderUrl: "https://coder.example.com", coderUserId: "", username: "testuser", email: "test@example.com" },
      session: { id: "", sessionId: "sess-123", expiresAt: new Date(Date.now() + 86400000) },
    });
  });

  it("calls auth service logout and clears cookie", async () => {
    mockServiceClient.logout.mockResolvedValue(undefined);

    const result = await logoutAction();

    expect(result?.data).toEqual({ success: true });
    expect(mockServiceClient.logout).toHaveBeenCalledWith("sess-123");
    expect(mockClearSessionCookie).toHaveBeenCalledWith(mockCookieStore);
  });
});

describe("getSessionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: "u1", coderUrl: "https://coder.example.com", coderUserId: "", username: "testuser", email: "test@example.com" },
      session: { id: "", sessionId: "sess-123", expiresAt: new Date(Date.now() + 86400000) },
    });
  });

  it("returns user info from session", async () => {
    const result = await getSessionAction();

    expect(result?.data).toEqual({
      user: {
        id: "u1",
        email: "test@example.com",
        coderUrl: "https://coder.example.com",
      },
    });
  });
});

describe("getTokenStatusAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: "u1", coderUrl: "https://coder.example.com", coderUserId: "", username: "testuser", email: "test@example.com" },
      session: { id: "", sessionId: "sess-123", expiresAt: new Date(Date.now() + 86400000) },
    });
  });

  it("returns credential status from auth service", async () => {
    const expiresAt = new Date(Date.now() + 86400000);
    mockServiceClient.getCredentials.mockResolvedValue({
      status: "valid",
      expiresAt,
    });

    const result = await getTokenStatusAction();

    expect(result?.data).toEqual({ status: "valid", expiresAt });
    expect(mockServiceClient.getCredentials).toHaveBeenCalledWith("sess-123");
  });

  it("returns expired status when credentials not found", async () => {
    mockServiceClient.getCredentials.mockResolvedValue(null);

    const result = await getTokenStatusAction();

    expect(result?.data).toEqual({ status: "expired", expiresAt: null });
  });
});

describe("authActionClient rejection", () => {
  it("returns error when no session exists", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await getSessionAction();

    expect(result?.serverError).toBe("Not authenticated");
  });
});
