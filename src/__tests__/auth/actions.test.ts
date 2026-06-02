import { beforeEach, describe, expect, it, vi } from "vitest";

const mockServiceClient = vi.hoisted(() => ({
  getCredentials: vi.fn(),
}));

const mockGetSession = vi.hoisted(() => vi.fn());

const mockCookieStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mockCookieStore),
}));

vi.mock("@/lib/auth/service-client", () => ({
  getAuthServiceClient: () => mockServiceClient,
}));

vi.mock("@/lib/auth/session", () => ({
  getRequestSession: (...args: unknown[]) => mockGetSession(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { getSessionAction, getTokenStatusAction } from "@/lib/auth/actions";

describe("getSessionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.example.com",
        coderUserId: "",
        username: "testuser",
        email: "test@example.com",
      },
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
      user: {
        id: "u1",
        coderUrl: "https://coder.example.com",
        coderUserId: "",
        username: "testuser",
        email: "test@example.com",
      },
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
