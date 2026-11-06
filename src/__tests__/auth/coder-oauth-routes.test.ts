import { CODER_OAUTH_FLOW_COOKIE, sessionCookieName, verifyCookie } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  complete: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@/lib/auth/service-client", () => ({
  getAuthServiceClient: () => ({
    startCoderOAuth: mocks.start,
    completeCoderOAuth: mocks.complete,
  }),
}));
vi.mock("@/lib/auth/rate-limit", () => ({ loginRateLimiter: { check: mocks.limit } }));

import { coderOAuthCallback, coderOAuthStart } from "@/lib/auth/coder-oauth-routes.server";

const origin = "https://hive.example";
const coder = "https://coder.kethalia.com";
const callback = `${origin}/api/auth/coder/callback`;
const state = "s".repeat(43);
const browserSecret = "b".repeat(43);
const sessionId = "c67fe15e-bdc8-4a7e-8bc8-dac9b2450105";
const failure = `${origin}/login?error=coder_oauth_failed`;
const cookie = `${CODER_OAUTH_FLOW_COOKIE}=${browserSecret}`;
const authUrl = () => {
  const url = new URL(`${coder}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "test-client",
    redirect_uri: callback,
    state,
    scope: "coder:all",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  return url;
};
const callbackRequest = (query = `state=${state}&code=synthetic-code`, cookies = cookie) =>
  new Request(`${callback}?${query}`, { headers: { Cookie: cookies } });

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({
    NODE_ENV: "production",
    HIVE_RUNTIME_TARGET: "cloudflare",
    HIVE_CODER_OAUTH_ENABLED: "true",
    CODER_URL: coder,
    HIVE_PUBLIC_ORIGIN: origin,
    HIVE_CODER_OAUTH_CLIENT_ID: "test-client",
    HIVE_CODER_OAUTH_CLIENT_SECRET: "synthetic-confidential-client",
    COOKIE_SECRET: "synthetic-cookie-signing-key",
  }))
    vi.stubEnv(key, value);
  mocks.limit.mockReturnValue({ allowed: true });
  mocks.start.mockResolvedValue({
    authorizationUrl: authUrl().href,
    browserSecret,
    expiresIn: 600,
  });
  mocks.complete.mockResolvedValue({
    sessionId,
    applicationsHost: "*.apps.coder.kethalia.com",
    user: { id: "hive-user", username: "test-user", email: "test@example.com", coderUrl: coder },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("public Coder OAuth navigation", () => {
  it("starts at fixed Coder origin and binds the return to a secure browser cookie", async () => {
    const request = new Request(`${origin}/api/auth/coder/start`, {
      headers: { "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": "192.0.2.8" },
    });
    const response = await coderOAuthStart(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(authUrl().href);
    expect(mocks.start).toHaveBeenCalledWith("192.0.2.8", request.signal);
    expect(response.headers.get("set-cookie")).toBe(
      `${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("location")).not.toContain("synthetic-confidential-client");
  });

  it("rejects cross-site, noncanonical, queried and non-GET starts before service calls", async () => {
    const requests = [
      new Request(`${origin}/api/auth/coder/start`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
      new Request(`${origin}/api/auth/coder/start`, {
        headers: { Origin: "https://foreign.example" },
      }),
      new Request(`https://foreign.example/api/auth/coder/start`),
      new Request(`${origin}/api/auth/coder/start?redirect=https://foreign.example`),
      new Request(`${origin}/api/auth/coder/start`, { method: "POST" }),
    ];
    for (const request of requests) expect((await coderOAuthStart(request)).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("uses provider IP and blocks limited starts without allocating a flow", async () => {
    mocks.limit.mockReturnValue({ allowed: false });
    const response = await coderOAuthStart(
      new Request(`${origin}/api/auth/coder/start`, {
        headers: { "CF-Connecting-IP": "192.0.2.9", "X-Forwarded-For": "spoofed" },
      }),
    );
    expect(response.status).toBe(429);
    expect(mocks.limit).toHaveBeenCalledWith("192.0.2.9");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("refuses unsafe provider redirects and never exposes provider failure details", async () => {
    for (const change of [
      (u: URL) => {
        u.hostname = "foreign.example";
      },
      (u: URL) => {
        u.searchParams.set("redirect_uri", "https://foreign.example");
      },
      (u: URL) => {
        u.searchParams.set("client_secret", "synthetic-confidential-client");
      },
      (u: URL) => {
        u.searchParams.set("code_verifier", "private-verifier");
      },
      (u: URL) => {
        u.searchParams.set("code_challenge_method", "plain");
      },
    ]) {
      const url = authUrl();
      change(url);
      mocks.start.mockResolvedValueOnce({
        authorizationUrl: url.href,
        browserSecret,
        expiresIn: 600,
      });
      const response = await coderOAuthStart(new Request(`${origin}/api/auth/coder/start`));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(failure);
      expect(response.headers.has("set-cookie")).toBe(false);
    }
    mocks.start.mockRejectedValueOnce(new Error("private-provider-token"));
    const response = await coderOAuthStart(new Request(`${origin}/api/auth/coder/start`));
    expect(response.headers.get("location")).toBe(failure);
    expect(await response.text()).not.toContain("private-provider-token");
  });
});

describe("Coder OAuth callback", () => {
  it("delegates the browser-bound code and issues a normal signed Hive session", async () => {
    const request = callbackRequest();
    const response = await coderOAuthCallback(request);
    expect(mocks.complete).toHaveBeenCalledWith(
      { state, browserSecret, code: "synthetic-code", denied: false },
      request.signal,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/workspaces`);
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some(
        (value) => value.startsWith(`${CODER_OAUTH_FLOW_COOKIE}=;`) && value.includes("Max-Age=0"),
      ),
    ).toBe(true);
    const session = cookies.find(
      (value) => value.startsWith(`${sessionCookieName()}=`) && !value.includes("Max-Age=0"),
    );
    expect(session).toBeTruthy();
    const signed = session!.split(";")[0].slice(sessionCookieName().length + 1);
    expect(verifyCookie(signed, "synthetic-cookie-signing-key")?.sessionId).toBe(sessionId);
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).not.toContain("Domain=");
    expect(cookies.join(" ")).toContain("apps.coder.kethalia.com");
    expect(cookies.join(" ")).not.toContain("synthetic-code");
    expect(cookies.join(" ")).not.toContain("synthetic-confidential-client");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects duplicate or missing browser binding, duplicate state/code and issuer mismatch", async () => {
    for (const request of [
      callbackRequest(undefined, ""),
      callbackRequest(undefined, `${cookie}; ${cookie}`),
      callbackRequest(`state=${state}&state=${state}&code=test`),
      callbackRequest(`state=${state}&code=a&code=b`),
      callbackRequest(`state=${state}&code=a&iss=https://foreign.example`),
      callbackRequest(`state=${state}&code=a&arbitrary=private`),
      new Request(`https://foreign.example/api/auth/coder/callback?state=${state}&code=a`, {
        headers: { Cookie: cookie },
      }),
    ]) {
      const response = await coderOAuthCallback(request);
      expect(response.headers.get("location")).toBe(failure);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    }
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("consumes a denial through the same one-use service path without clearing an existing Hive session", async () => {
    mocks.complete.mockRejectedValue(new Error("denied-private-description"));
    const response = await coderOAuthCallback(
      callbackRequest(
        `state=${state}&error=access_denied&error_description=private-description`,
        `${cookie}; ${sessionCookieName()}=existing-session`,
      ),
    );
    expect(mocks.complete.mock.calls[0][0]).toEqual({
      state,
      browserSecret,
      code: undefined,
      denied: true,
    });
    expect(response.headers.get("location")).toBe(failure);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.get("set-cookie")).not.toContain(sessionCookieName());
    expect(await response.text()).not.toContain("private-description");
  });

  it("never issues session cookies for failed replay, wrong origin or malformed session results", async () => {
    const results = [
      Promise.reject(new Error("flow-already-consumed")),
      Promise.resolve({ sessionId, user: { coderUrl: "https://foreign.example" } }),
      Promise.resolve({ sessionId: "not-a-session", user: { coderUrl: coder } }),
    ];
    // Register handlers synchronously so a rejected fixture cannot be unhandled.
    for (const result of results) result.catch(() => {});
    for (const result of results) {
      mocks.complete.mockImplementationOnce(() => result);
      const response = await coderOAuthCallback(callbackRequest());
      expect(response.headers.get("location")).toBe(failure);
      expect(response.headers.getSetCookie()).toHaveLength(1);
    }
  });

  it("keeps disabled and incomplete configuration closed without service calls", async () => {
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
    expect((await coderOAuthStart(new Request(`${origin}/api/auth/coder/start`))).status).toBe(404);
    expect((await coderOAuthCallback(callbackRequest())).status).toBe(404);
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
    vi.stubEnv("HIVE_CODER_OAUTH_CLIENT_SECRET", "");
    expect((await coderOAuthStart(new Request(`${origin}/api/auth/coder/start`))).status).toBe(503);
    const callbackResponse = await coderOAuthCallback(callbackRequest());
    expect(callbackResponse.status).toBe(503);
    expect(callbackResponse.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
