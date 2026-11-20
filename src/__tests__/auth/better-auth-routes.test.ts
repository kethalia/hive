import { runInNewContext } from "node:vm";
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
import { CODER_OAUTH_POPUP_MESSAGE } from "@/lib/auth/coder-oauth-popup";

const origin = "https://hive.oauth.invalid";
const attempt = "10000000-0000-4000-8000-000000000001";
function completionMessage(html: string) {
  const postMessage = vi.fn();
  const close = vi.fn();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  runInNewContext(script ?? "", { window: { opener: { postMessage }, close } });
  expect(close).not.toHaveBeenCalled();
  return postMessage;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
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
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Set-Cookie")).toContain("__Host-hive-oauth-state");
    expect(await mocks.handler.mock.calls[0][0].json()).toEqual({
      provider: "coder",
      callbackURL: "/workspaces",
      errorCallbackURL: "/login",
      disableRedirect: true,
    });
  });
  it("uses fixed popup completion callbacks while ignoring supplied redirect targets", async () => {
    mocks.handler.mockResolvedValue(
      Response.json({ url: "https://coder.oauth.invalid/oauth2/authorize" }),
    );
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "coder",
          popup: attempt,
          callbackURL: "https://attacker.invalid/",
          errorCallbackURL: "https://attacker.invalid/",
          disableRedirect: false,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await mocks.handler.mock.calls[0][0].json()).toEqual({
      provider: "coder",
      callbackURL: `/login/complete?attempt=${attempt}`,
      errorCallbackURL: `/login/complete?attempt=${attempt}&error=1`,
      disableRedirect: true,
    });
  });

  it.each([
    null,
    false,
    12,
    {},
    [],
    "",
    "not-a-uuid",
    `${attempt}&error=0`,
    "https://attacker.invalid/",
  ])("rejects invalid provided popup attempt %j before invoking the framework", async (popup) => {
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "coder", popup }),
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it.each([
    { location: "/workspaces", type: "application/json", success: true },
    {
      location: `/login/complete?attempt=${attempt}`,
      type: "application/octet-stream",
      success: true,
      popup: true,
    },
    {
      location: `${origin}/login/complete?attempt=${attempt}`,
      type: "",
      success: true,
      popup: true,
    },
    { location: "/login?error=access_denied", type: "application/json", success: false },
    {
      location: `/login/complete?attempt=${attempt}&error=1`,
      type: "application/json",
      success: false,
      popup: true,
    },
    {
      location: `/login/complete?attempt=${attempt}&error=`,
      type: "application/octet-stream",
      success: false,
      popup: true,
    },
    { location: "/login/complete?attempt=invalid", type: "application/json", success: false },
    {
      location: `/login/complete?attempt=${attempt}&attempt=${attempt}`,
      type: "application/json",
      success: false,
    },
    { location: "https://another.invalid/workspaces", type: "application/json", success: false },
    {
      location: `https://another.invalid/login/complete?attempt=${attempt}`,
      type: "application/json",
      success: false,
    },
  ])("types the framework redirect and scopes callback cookie changes for $location", async ({
    location,
    type,
    success,
    popup,
  }) => {
    const cookie = "__Host-hive-auth=framework-cookie; Path=/; Secure; HttpOnly";
    mocks.handler.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          Location: location,
          "Content-Type": type,
          "Set-Cookie": cookie,
        },
      }),
    );
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/callback/coder?code=fixture&state=fixture`),
    );
    expect(response.status).toBe(popup ? 200 : 302);
    expect(response.headers.get("Location")).toBe(popup ? null : location);
    expect(response.headers.get("Content-Type")).toBe(
      popup ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.getSetCookie()).toContain(cookie);
    const html = await response.text();
    if (popup) {
      expect(completionMessage(html)).toHaveBeenCalledWith(
        { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: false },
        origin,
      );
    } else expect(html).toBe("");
    expect(
      response.headers.getSetCookie().some((value) => value.startsWith("hive-coder-host=")),
    ).toBe(success);
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("hive-session=;") && value.includes("Max-Age=0")),
    ).toBe(success);
    expect(mocks.session).toHaveBeenCalledTimes(success ? 1 : 0);
  });

  it("renders the verified popup handoff directly while retaining all committed cookies", async () => {
    const cookies = [
      "__Host-hive-auth=framework-cookie; Path=/; Secure; HttpOnly",
      "__Host-hive-oauth-state=; Path=/; Secure; HttpOnly; Max-Age=0",
    ];
    const headers = new Headers({
      Location: `/login/complete?attempt=${attempt}`,
      "Content-Type": "application/json",
      "Content-Length": "17",
      "Content-Encoding": "gzip",
      "X-Frame-Options": "SAMEORIGIN",
    });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    mocks.handler.mockResolvedValue(new Response(null, { status: 302, headers }));
    mocks.session.mockResolvedValue({
      user: { id: "private-user" },
      session: { id: "private-id" },
    });
    mocks.credential.mockRejectedValue(new Error("Ancillary lookup unavailable"));
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/callback/coder?code=private-code&state=private-state`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    for (const cookie of cookies) expect(response.headers.getSetCookie()).toContain(cookie);
    expect(response.headers.get("Set-Cookie")).toContain("hive-coder-host=");
    expect(mocks.session).toHaveBeenCalledOnce();
    const html = await response.text();
    expect(completionMessage(html)).toHaveBeenCalledWith(
      { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: true },
      origin,
    );
    expect(html).toContain('<main class="coder-oauth-popup">');
    expect(html).toContain('class="coder-oauth-popup-mark" aria-hidden="true">H_');
    expect(html).toContain('role="status" data-pending><span>Finishing sign-in to Hive…');
    expect(html).toContain('<a href="/workspaces">Open Hive</a>');
    expect(html).not.toMatch(/private-|framework-cookie|_next\/|<script src/);
  });

  it("preserves committed cookies when popup session verification fails", async () => {
    const cookie = "__Host-hive-auth=framework-cookie; Path=/; Secure; HttpOnly";
    mocks.handler.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: `/login/complete?attempt=${attempt}`, "Set-Cookie": cookie },
      }),
    );
    mocks.session.mockRejectedValue(new Error("Unavailable"));
    const response = await handleCoderAuth(new Request(`${origin}/api/auth/callback/coder`));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toContain(cookie);
    expect(completionMessage(await response.text())).toHaveBeenCalledWith(
      { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: false },
      origin,
    );
  });

  it("renders popup provider failure without reflecting encoded provider text or callback secrets", async () => {
    const error = encodeURIComponent('</script><script>alert("provider-detail")</script>');
    mocks.handler.mockResolvedValue(
      new Response("private-provider-body", {
        status: 302,
        headers: { Location: `/login/complete?attempt=${attempt}&error=${error}` },
      }),
    );
    const response = await handleCoderAuth(
      new Request(`${origin}/api/auth/callback/coder?code=private-code&state=private-state`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    const html = await response.text();
    expect(completionMessage(html)).toHaveBeenCalledWith(
      { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success: false },
      origin,
    );
    expect(html).toContain('<main class="coder-oauth-popup">');
    expect(html).toContain('class="coder-oauth-popup-mark" aria-hidden="true">H_');
    expect(html).toContain('role="alert"><span>Coder sign-in did not complete.');
    expect(html).not.toMatch(/private-|provider-detail|alert\(/);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("gives an untyped empty callback failure readable text while preserving JSON failures", async () => {
    mocks.handler.mockResolvedValueOnce(new Response(null, { status: 400 }));
    const plain = await handleCoderAuth(new Request(`${origin}/api/auth/callback/coder`));
    expect(plain.status).toBe(400);
    expect(plain.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(plain.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await plain.text()).toContain("Return to Hive");
    mocks.handler.mockResolvedValueOnce(Response.json({ error: "invalid_state" }, { status: 400 }));
    const json = await handleCoderAuth(new Request(`${origin}/api/auth/callback/coder`));
    expect(json.status).toBe(400);
    expect(json.headers.get("Content-Type")).toContain("application/json");
    expect(json.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await json.json()).toEqual({ error: "invalid_state" });
  });

  it.each([
    204, 205,
  ])("retains the empty body contract of an untyped callback %s", async (status) => {
    mocks.handler.mockResolvedValue(new Response(null, { status }));
    const response = await handleCoderAuth(new Request(`${origin}/api/auth/callback/coder`));
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("");
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
