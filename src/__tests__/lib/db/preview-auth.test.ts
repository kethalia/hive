import { describe, expect, it } from "vitest";
import {
  authorizePreview,
  bootstrapPreview,
  PREVIEW_COOKIE,
  privatePreviewResponse,
  withoutPreviewCredential,
} from "../../../../deploy/cloudflare/app/preview-auth";

const secret = "a".repeat(64);
describe("private app preview authority", () => {
  it.each([
    undefined,
    "",
    "invalid",
    123,
  ])("fails closed on missing/invalid runtime secret: %s", (value) => {
    expect(authorizePreview(new Request("https://preview.example/login"), value)?.status).toBe(503);
  });
  it.each([
    null,
    "Bearer wrong",
    `Basic ${secret}`,
    `Bearer ${"é".repeat(64)}`,
  ])("rejects invalid headers safely: %s", async (authorization) => {
    const request = new Request(`https://preview.example/login?token=${secret}`, {
      headers: authorization ? { Authorization: authorization } : {},
    });
    const response = authorizePreview(request, secret);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.text()).not.toContain(secret);
  });
  it("authorizes only the separate header and strips it before framework delegation", async () => {
    const request = new Request("https://preview.example/api/auth/login", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, Cookie: "hive-session=fixture" },
      body: "fixture-body",
    });
    expect(authorizePreview(request, secret)).toBeNull();
    const delegated = withoutPreviewCredential(request);
    expect(delegated.headers.has("authorization")).toBe(false);
    expect(delegated.headers.get("cookie")).toBe("hive-session=fixture");
    expect(await delegated.text()).toBe("fixture-body");
  });
  it("makes authorized assets and HTML private while preserving cookie variance and streaming", async () => {
    const original = new Response("asset", {
      headers: { "Cache-Control": "public, max-age=86400", Vary: "Cookie" },
    });
    const response = privatePreviewResponse(original);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
    expect(await response.text()).toBe("asset");
    const once = privatePreviewResponse(new Response(null, { headers: { Vary: "authorization" } }));
    expect(once.headers.get("vary")).toBe("authorization");
  });
});

describe("same-origin private preview cookie", () => {
  const origin = "https://preview.example";
  const options = { origin, cookieSecret: "b".repeat(64), now: Date.parse("2026-10-29T18:00:00Z") };
  function issue() {
    const response = bootstrapPreview(
      new Request(`${origin}/__hive-preview/access`, {
        method: "POST",
        headers: { Origin: origin, Authorization: `Bearer ${secret}` },
      }),
      secret,
      options,
    );
    expect(response?.status).toBe(204);
    const header = response?.headers.get("set-cookie") ?? "";
    expect(header).toContain("Secure; HttpOnly; SameSite=Strict");
    expect(header).toContain("Path=/; Max-Age=900");
    expect(header).not.toContain("Domain=");
    expect(header).not.toContain(secret);
    return header.split(";")[0];
  }
  it("bootstraps signed15min cookie for assets/WS and strips preview authority before delegation", () => {
    const cookie = issue();
    const request = new Request(
      `${origin}/api/projects/00000000-0000-4000-8000-000000000000/session`,
      { headers: { Cookie: `${cookie}; __Host-hive-session=owner-session`, Upgrade: "websocket" } },
    );
    expect(authorizePreview(request, secret, options)).toBeNull();
    const delegated = withoutPreviewCredential(request);
    expect(delegated.headers.get("cookie")).toBe("__Host-hive-session=owner-session");
    expect(delegated.headers.has("authorization")).toBe(false);
  });
  it("rejects tampering, expiry, wrongorigin, duplicatecookies and missingruntimecookiekey", () => {
    const cookie = issue();
    const request = (value: string, base = origin) =>
      new Request(`${base}/login`, { headers: { Cookie: value } });
    expect(authorizePreview(request(`${cookie}tampered`), secret, options)?.status).toBe(401);
    expect(
      authorizePreview(request(cookie), secret, { ...options, now: options.now + 900000 })?.status,
    ).toBe(401);
    expect(
      authorizePreview(request(cookie, "https://other.example"), secret, options)?.status,
    ).toBe(401);
    expect(authorizePreview(request(`${cookie}; ${cookie}`), secret, options)?.status).toBe(401);
    expect(authorizePreview(request(cookie), secret, { origin })?.status).toBe(401);
  });
  it("requires bearer plus exact Origin, emptybody and noquery forbootstrap; cookiealone cannotrenew", () => {
    const cookie = issue();
    for (const [url, init, expected] of [
      [
        `${origin}/__hive-preview/access`,
        { method: "POST", headers: { Cookie: cookie, Origin: origin } },
        401,
      ],
      [
        `${origin}/__hive-preview/access`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, Origin: "https://other.example" },
        },
        403,
      ],
      [
        `${origin}/__hive-preview/access?token=not-supported`,
        { method: "POST", headers: { Authorization: `Bearer ${secret}`, Origin: origin } },
        400,
      ],
      [
        `${origin}/__hive-preview/access`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, Origin: origin },
          body: "ignored",
        },
        400,
      ],
      [`${origin}/__hive-preview/access`, { method: "GET" }, 405],
    ] as const)
      expect(bootstrapPreview(new Request(url, init), secret, options)?.status).toBe(expected);
    expect(cookie.startsWith(`${PREVIEW_COOKIE}=`)).toBe(true);
  });
});
