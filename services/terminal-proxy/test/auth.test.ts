import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hive/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/auth")>()),
  verifyCookie: vi.fn(),
}));

import { createTerminalTicket, verifyCookie } from "@hive/auth";
import { authenticateUpgrade } from "../src/auth.js";

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
      AUTH_SERVICE_SECRET: "a".repeat(64),
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

  it.each([
    "authorization",
    "sec-websocket-protocol",
  ])("accepts a bound terminal ticket over %s without a session cookie", async (header) => {
    process.env.NODE_ENV = "production";
    const ticket = createTerminalTicket(
      {
        sessionId: "sess-1",
        audience: "terminal.example.com",
        origin: "https://hive.example.com",
        requestTarget: "/ws?agentId=agent",
      },
      "test-secret",
      Date.now() + 60_000,
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok", coderUrl: "http://coder" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ username: "victim" }),
    });
    const req = makeReq({
      host: "terminal.example.com",
      origin: "https://hive.example.com",
      [header]:
        header === "authorization" ? `Bearer ${ticket}` : `hive-terminal-v1, hive-ticket.${ticket}`,
    });
    req.url = "/ws?agentId=agent";
    expect(await authenticateUpgrade(req)).toMatchObject({
      ok: true,
      value: { sessionId: "sess-1", username: "victim" },
    });
    expect(mockVerifyCookie).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { host: "another.example.com" },
    { origin: "https://attacker.example.com" },
    { target: "/ws?agentId=other" },
    { target: "/ws/audio?agentId=agent" },
  ])("rejects ticket authority/target substitution before fetching tokens: %o", async (change) => {
    const ticket = createTerminalTicket(
      {
        sessionId: "sess-1",
        audience: "terminal.example.com",
        origin: "https://hive.example.com",
        requestTarget: "/ws?agentId=agent",
      },
      "test-secret",
      Date.now() + 60_000,
    );
    const req = makeReq({
      authorization: `Bearer ${ticket}`,
      host: change.host || "terminal.example.com",
      origin: change.origin || "https://hive.example.com",
    });
    req.url = change.target || "/ws?agentId=agent";
    expect(await authenticateUpgrade(req)).toMatchObject({
      ok: false,
      value: { status: 401, reason: "invalid_terminal_ticket" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to a cookie when a ticket is invalid or ambiguous", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "victim" });
    for (const protocols of ["hive-ticket.invalid", "hive-ticket.one, hive-ticket.two"]) {
      const req = makeReq({ cookie: "hive-session=valid", "sec-websocket-protocol": protocols });
      expect(await authenticateUpgrade(req)).toMatchObject({
        ok: false,
        value: { reason: "invalid_terminal_ticket" },
      });
    }
    expect(mockVerifyCookie).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin ticket without Origin but supports same-origin GETs", async () => {
    process.env.NODE_ENV = "production";
    const target = {
      sessionId: "sess-1",
      audience: "terminal.example.com",
      requestTarget: "/keepalive/status",
    };
    const ticket = (origin: string) =>
      createTerminalTicket({ ...target, origin }, "test-secret", Date.now() + 60_000);
    const req = makeReq({
      host: target.audience,
      authorization: `Bearer ${ticket("https://hive.example.com")}`,
    });
    req.url = target.requestTarget;
    expect(await authenticateUpgrade(req)).toMatchObject({
      ok: false,
      value: { reason: "invalid_terminal_ticket" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    req.headers.authorization = `Bearer ${ticket("https://terminal.example.com")}`;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok", coderUrl: "https://coder" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ username: "victim" }),
    });
    expect(await authenticateUpgrade(req)).toMatchObject({ ok: true });
  });

  it("ignores legacy cookies in production and accepts only the protected name", async () => {
    process.env.NODE_ENV = "production";
    expect(await authenticateUpgrade(makeReq({ cookie: "hive-session=legacy" }))).toMatchObject({
      ok: false,
      value: { status: 401 },
    });
    expect(mockVerifyCookie).not.toHaveBeenCalled();
    mockVerifyCookie.mockReturnValue(null);
    await authenticateUpgrade(
      makeReq({ cookie: "hive-session=attacker; __Host-hive-session=victim" }),
    );
    expect(mockVerifyCookie).toHaveBeenCalledWith("victim", "test-secret");
    expect(mockVerifyCookie).toHaveBeenCalledTimes(1);
  });

  it.each([
    "localhost:3001",
    "127.0.0.1:3001",
    "[::1]:3001",
  ])("accepts an origin-less production GET on its local HTTP authority: %s", async (host) => {
    process.env.NODE_ENV = "production";
    delete process.env.TERMINAL_PUBLIC_ORIGIN;
    const ticket = createTerminalTicket(
      {
        sessionId: "sess-1",
        audience: host,
        origin: `http://${host}`,
        requestTarget: "/keepalive/status",
      },
      "test-secret",
      Date.now() + 60_000,
    );
    const req = makeReq({ host, authorization: `Bearer ${ticket}` });
    req.url = "/keepalive/status";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok", coderUrl: "http://coder" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ username: "victim" }),
    });
    expect(await authenticateUpgrade(req)).toMatchObject({ ok: true });
  });

  it("authenticates the configured public terminal authority after Host rewriting", async () => {
    process.env.NODE_ENV = "production";
    process.env.TERMINAL_PUBLIC_ORIGIN = "https://terminal.example.com";
    const ticket = createTerminalTicket(
      {
        sessionId: "sess-1",
        audience: "terminal.example.com",
        origin: "https://hive.example.com",
        requestTarget: "/ws?agentId=agent",
      },
      "test-secret",
      Date.now() + 60_000,
    );
    const req = makeReq({
      host: "terminal-proxy:3001",
      origin: "https://hive.example.com",
      "sec-websocket-protocol": `hive-terminal-v1, hive-ticket.${ticket}`,
    });
    req.url = "/ws?agentId=agent";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok", coderUrl: "http://coder" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ username: "victim" }),
    });
    expect(await authenticateUpgrade(req)).toMatchObject({ ok: true });
  });

  it("preserves an explicit non-default TLS port when inferring public authority", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.TERMINAL_PUBLIC_ORIGIN;
    const ticket = createTerminalTicket(
      {
        sessionId: "sess-1",
        audience: "terminal.example.com:80",
        origin: "https://hive.example.com",
        requestTarget: "/ws?agentId=agent",
      },
      "test-secret",
      Date.now() + 60_000,
    );
    const req = makeReq({
      host: "terminal.example.com:80",
      origin: "https://hive.example.com",
      "sec-websocket-protocol": `hive-terminal-v1, hive-ticket.${ticket}`,
    });
    req.url = "/ws?agentId=agent";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "tok", coderUrl: "https://coder" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ username: "victim" }),
    });
    expect(await authenticateUpgrade(req)).toMatchObject({ ok: true });
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
      json: () =>
        Promise.resolve({
          token: "coder-token-123",
          coderUrl: "http://coder.test",
          expiresAt: null,
        }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ username: "alice" }),
    });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=valid" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.headers).toEqual({ Authorization: `Bearer ${"a".repeat(64)}` });
      expect(options.redirect).toBe("error");
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.token).toBe("coder-token-123");
      expect(result.value.coderUrl).toBe("http://coder.test");
      expect(result.value.sessionId).toBe("sess-abc");
      expect(result.value.username).toBe("alice");
    }
  });

  it.each([
    undefined,
    "",
    "replace-me",
    "g".repeat(64),
  ])("returns 502 without calling the auth service when its secret is missing or malformed", async (secret) => {
    if (secret === undefined) delete process.env.AUTH_SERVICE_SECRET;
    else process.env.AUTH_SERVICE_SECRET = secret;
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });

    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=valid" }));

    expect(result).toEqual({
      ok: false,
      value: { error: "Server misconfigured", status: 502, reason: "auth_service_secret_invalid" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats auth-service credential rejection as a backend failure", async () => {
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const result = await authenticateUpgrade(makeReq({ cookie: "hive-session=valid" }));
    expect(result).toEqual({
      ok: false,
      value: { error: "Token unavailable", status: 502, reason: "token_unavailable" },
    });
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

  it.each([
    "hive-session=stale; hive-session=fresh",
    "hive-session=victim; hive-session=attacker",
    "hive-session=attacker; hive-session=victim",
    "hive-session=same; hive-session=same",
    "hive-session=; hive-session=valid",
  ])("rejects duplicate cookies before contacting auth: %s", async (cookie) => {
    const result = await authenticateUpgrade(makeReq({ cookie }));
    expect(result).toMatchObject({ ok: false, value: { status: 401, reason: "ambiguous_cookie" } });
    expect(mockVerifyCookie).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs token values", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockVerifyCookie.mockReturnValue({ sessionId: "sess-1", timestamp: Date.now() });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ token: "secret-token-xyz", coderUrl: "http://c", expiresAt: null }),
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
        expect(String(arg)).not.toContain("a".repeat(64));
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
