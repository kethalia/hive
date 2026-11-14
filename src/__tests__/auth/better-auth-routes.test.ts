import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handler: vi.fn(),
  session: vi.fn(),
  credential: vi.fn(),
  host: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: () => ({}) }));
vi.mock("../../../services/auth/src/auth/better-auth", () => ({
  createCoderAuth: () => ({ handler: mocks.handler, api: { getSession: mocks.session } }),
}));
vi.mock("../../../services/auth/src/auth/coder-oauth-credentials", () => ({
  getUsableCoderCredential: mocks.credential,
}));
vi.mock("../../../services/auth/src/auth/coder-oauth-provider", () => ({
  coderOAuthApplicationsHost: mocks.host,
}));

import { handleCoderAuth } from "@/lib/auth/coder-auth.server";

const origin = "https://hive.oauth.invalid";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  vi.stubEnv("CODER_URL", "https://coder.oauth.invalid");
  vi.stubEnv("CODER_OAUTH_CLIENT_ID", "fixture-client");
  vi.stubEnv("CODER_OAUTH_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("COOKIE_SECRET", "a".repeat(64));
});
afterEach(() => vi.unstubAllEnvs());
describe("public Better Auth Coder routes", () => {
  it("uses JSON sign-in and fixed callbacks while preserving framework state cookies", async () => {
    mocks.handler.mockResolvedValue(
      Response.json(
        { url: "https://coder.oauth.invalid/oauth2/authorize" },
        { headers: { "Set-Cookie": "__Host-hive-oauth-state=fixture; Path=/; Secure; HttpOnly" } },
      ),
    );
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "coder", callbackURL: "https://attacker.invalid/" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Set-Cookie")).toContain("__Host-hive-oauth-state");
    expect(await mocks.handler.mock.calls[0][0].json()).toEqual({
      provider: "coder",
      callbackURL: "/workspaces",
      errorCallbackURL: "/login",
      disableRedirect: true,
    });
  });
  it.each([
    "/get-access-token",
    "/refresh-token",
    "/sign-up/email",
    "/update-user",
    "/link-social",
    "/get-session",
  ])("keeps credential and account mutation endpoint %s private", async (path) => {
    expect(
      (
        await handleCoderAuth(
          new Request(`${origin}/api/auth${path}`, { method: "POST", headers: { Origin: origin } }),
        )
      ).status,
    ).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });
  it("rejects cross-origin sign-in before invoking the framework", async () => {
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { Origin: "https://another.invalid" },
        body: '{"provider":"coder"}',
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.handler).not.toHaveBeenCalled();
  });
  it("rejects duplicate host-only authentication cookies", async () => {
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/callback/coder`, {
        headers: { Cookie: "__Host-hive-auth=a; __Host-hive-auth=a" },
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.handler).not.toHaveBeenCalled();
  });
  it("preserves a committed callback when frame-host credential verification is unavailable", async () => {
    mocks.handler.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          Location: "/workspaces",
          "Set-Cookie": "__Host-hive-auth=framework-cookie; Path=/; Secure; HttpOnly",
        },
      }),
    );
    mocks.session.mockResolvedValue({ user: { id: "owner" } });
    mocks.credential.mockRejectedValue(new Error("Transient provider outage"));
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/callback/coder?code=fixture&state=fixture`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/workspaces");
    expect(response.headers.getSetCookie()).toContain(
      "__Host-hive-auth=framework-cookie; Path=/; Secure; HttpOnly",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.host).not.toHaveBeenCalled();
  });
});
