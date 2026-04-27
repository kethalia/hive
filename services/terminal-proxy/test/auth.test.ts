import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";

vi.mock("@hive/auth", () => ({
  verifyCookie: vi.fn(),
}));

import { authenticateUpgrade } from "../src/auth.js";
import { verifyCookie } from "@hive/auth";

const mockVerifyCookie = verifyCookie as ReturnType<typeof vi.fn>;

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("authenticateUpgrade", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      COOKIE_SECRET: "test-secret",
      AUTH_SERVICE_URL: "http://localhost:4400",
    };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("returns 502 when COOKIE_SECRET is not configured", async () => {
    delete process.env.COOKIE_SECRET;
    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=abc" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(502);
      expect(result.value.reason).toBe("cookie_secret_missing");
    }
  });

  it("returns 401 when no Cookie header", async () => {
    const result = await authenticateUpgrade(makeReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(401);
      expect(result.value.reason).toBe("no_cookie");
    }
  });

  it("returns 401 when Cookie header has no hive-session", async () => {
    const result = await authenticateUpgrade(makeReq({ cookie: "other=value" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(401);
      expect(result.value.reason).toBe("no_cookie");
    }
  });

  it("returns 401 when verifyCookie returns null (invalid HMAC)", async () => {
    mockVerifyCookie.mockReturnValue(null);
    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=bad.signature" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(401);
      expect(result.value.reason).toBe("invalid_hmac");
    }
  });

  it("calls verifyCookie with cookie value and secret", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "tok", coderUrl: "http://coder", expiresAt: null }),
    });
    // second fetch for session
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "tok", coderUrl: "http://coder", expiresAt: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "user1" }),
    });

    await authenticateUpgrade(makeReq({ cookie: "hive-session=my-cookie-value" }));
    expect(mockVerifyCookie).toHaveBeenCalledWith("my-cookie-value", "test-secret");
  });

  it("returns 401 when auth service returns 404 (session not found)", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=valid" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(401);
      expect(result.value.reason).toBe("session_not_found");
    }
  });

  it("returns 502 when auth service returns 500", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "u" }),
    });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=valid" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(502);
      expect(result.value.reason).toBe("token_unavailable");
    }
  });

  it("returns 502 when auth service is unreachable (network error)", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockRejectedValue(new Error("fetch failed"));

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=valid" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(502);
      expect(result.value.reason).toBe("auth_service_unreachable");
    }
  });

  it("returns success with token and coderUrl on valid auth", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-abc", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "coder-token-123", coderUrl: "http://coder.test", expiresAt: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "alice" }),
    });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=valid" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.token).toBe("coder-token-123");
      expect(result.value.coderUrl).toBe("http://coder.test");
      expect(result.value.sessionId).toBe("sess-abc");
      expect(result.value.username).toBe("alice");
    }
  });

  it("parses hive-session from multiple cookies correctly", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "tok", coderUrl: "http://c", expiresAt: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "u" }),
    });

    const result = await authenticateUpgrade(
      makeReq({ cookie: "other=x; hive-session=my-val; another=y" }),
    );
    expect(mockVerifyCookie).toHaveBeenCalledWith("my-val", "test-secret");
    expect(result.ok).toBe(true);
  });

  it("never logs token values", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "secret-token-xyz", coderUrl: "http://c", expiresAt: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "u" }),
    });

    await authenticateUpgrade(makeReq({ cookie: "hive-session=val" }));

    for (const call of [...logSpy.mock.calls, ...errSpy.mock.calls]) {
      for (const arg of call) {
        expect(String(arg)).not.toContain("secret-token-xyz");
      }
    }

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("returns 502 when auth service returns malformed JSON", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error("invalid json")),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "u" }),
    });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=val" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(502);
      expect(result.value.reason).toBe("token_unavailable");
    }
  });

  it("returns 502 when token response is missing token field", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ coderUrl: "http://c", expiresAt: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "u" }),
    });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=val" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.value.status).toBe(502);
      expect(result.value.reason).toBe("token_unavailable");
    }
  });

  it("uses default AUTH_SERVICE_URL when env var is not set", async () => {
    delete process.env.AUTH_SERVICE_URL;
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "tok", coderUrl: "http://c", expiresAt: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "u" }),
    });

    await authenticateUpgrade(makeReq({ cookie: "hive-session=val" }));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("http://localhost:4400/sessions/sess-1/token");
  });

  it("proceeds without username when session endpoint fails", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: "tok", coderUrl: "http://c", expiresAt: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("fail")),
    });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=val" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.username).toBe("");
    }
  });
});
