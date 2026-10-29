import { AuthServiceClient } from "@hive/auth";
import { describe, expect, it, vi } from "vitest";
import { createFetchAuthHandler } from "../src/fetch-handler";

const secret = "a".repeat(64);
const session = {
  user: {
    id: "user-id",
    coderUserId: "coder-id",
    username: "test-user",
    email: "test@example.com",
    coderUrl: "https://coder.example.com",
  },
  session: { id: "row-id", sessionId: "session-id", expiresAt: new Date("2030-01-01") },
};

function fixture() {
  const operations = {
    performLogin: vi.fn().mockResolvedValue({
      sessionId: session.session.sessionId,
      user: session.user,
      applicationsHost: "*.coder.example.com",
    }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    getSessionById: vi.fn().mockResolvedValue(session),
    getTokenStatus: vi
      .fn()
      .mockResolvedValue({ status: "valid", expiresAt: new Date("2030-01-01") }),
    getDecryptedCoderToken: vi.fn().mockResolvedValue({ token: "fixture-token", expiresAt: null }),
  };
  const limiter = { check: vi.fn().mockReturnValue({ allowed: true, remaining: 4, resetMs: 0 }) };
  return { operations, limiter, handle: createFetchAuthHandler(secret, operations, limiter) };
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://auth.internal${path}`, {
    ...init,
    headers: { authorization: `Bearer ${secret}`, ...init.headers },
  });
}

describe("Fetch authentication transport", () => {
  it("rejects configuration and authenticates before routing or reading a body", async () => {
    expect(() => createFetchAuthHandler("invalid")).toThrow();
    const { handle, operations } = fixture();
    const invalid = new Request("https://auth.internal/login", {
      method: "POST",
      body: "{invalid",
    });
    expect((await handle(invalid)).status).toBe(401);
    expect(invalid.bodyUsed).toBe(false);
    expect((await handle(new Request("https://auth.internal/health"))).status).toBe(200);
    expect(
      (await handle(new Request("https://auth.internal/health", { method: "POST" }))).status,
    ).toBe(401);
    expect((await handle(new Request("https://auth.internal/unknown"))).status).toBe(401);
    expect(operations.performLogin).not.toHaveBeenCalled();
  });

  it("serves all existing client operations without an origin HTTP server", async () => {
    const { handle, operations } = fixture();
    const transport = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(input, init)),
    );
    const client = new AuthServiceClient("https://auth.internal", undefined, {
      fetch: transport,
      serviceSecret: secret,
    });
    expect((await client.login({ email: "test@example.com", password: "fixture" })).sessionId).toBe(
      "session-id",
    );
    expect((await client.getSession("session-id"))?.userId).toBe("user-id");
    expect((await client.getCredentials("session-id"))?.status).toBe("valid");
    expect((await client.getCoderToken("session-id"))?.token).toBe("fixture-token");
    await client.logout("session-id");
    expect(operations.deleteSession).toHaveBeenCalledWith("session-id");
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it("bounds JSON bytes, rejects malformed input and server-origin overrides", async () => {
    const { handle, operations } = fixture();
    for (const [body, status] of [
      ["{invalid", 400],
      ["x".repeat(1024 * 1024 + 1), 413],
      [JSON.stringify({ email: "e", password: "p", coderUrl: "https://attacker.example" }), 400],
      [JSON.stringify({ email: "e", password: "" }), 400],
      ["[]", 400],
    ] as const) {
      expect((await handle(req("/login", { method: "POST", body }))).status).toBe(status);
    }
    expect(operations.performLogin).not.toHaveBeenCalled();
  });

  it("preserves rate limit and login error categories without exposing backend details", async () => {
    const { handle, operations, limiter } = fixture();
    const login = () =>
      req("/login", {
        method: "POST",
        body: JSON.stringify({ email: "e", password: "p" }),
        headers: { "X-Hive-Client-IP": "203.0.113.5", "X-Forwarded-For": "spoofed" },
      });
    limiter.check.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 123 });
    expect((await handle(login())).status).toBe(429);
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.5");
    for (const [message, status, code] of [
      ["invalid credentials", 401, "INVALID_CREDENTIALS"],
      ["Invalid Coder instance: test", 502, "CODER_UNREACHABLE"],
      ["database password=must-not-leak", 500, "INTERNAL_ERROR"],
    ] as const) {
      operations.performLogin.mockRejectedValueOnce(new Error(message));
      const response = await handle(login());
      expect(response.status).toBe(status);
      const payload = await response.json();
      expect(payload.code).toBe(code);
      expect(JSON.stringify(payload)).not.toContain("must-not-leak");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("preserves missing sessions and safe token-decryption errors", async () => {
    const { handle, operations } = fixture();
    operations.getSessionById.mockResolvedValueOnce(null);
    expect((await handle(req("/sessions/missing"))).status).toBe(404);
    operations.getDecryptedCoderToken.mockRejectedValueOnce(new Error("KEY_MISMATCH"));
    expect(await (await handle(req("/sessions/session-id/token"))).json()).toEqual({
      error: "Failed to retrieve token",
      code: "KEY_MISMATCH",
    });
    operations.getDecryptedCoderToken.mockRejectedValueOnce(new Error("secret detail"));
    expect(await (await handle(req("/sessions/session-id/token"))).json()).toEqual({
      error: "Failed to retrieve token",
      code: "INTERNAL_ERROR",
    });
  });
});
