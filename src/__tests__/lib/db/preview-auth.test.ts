import { describe, expect, it } from "vitest";
import {
  authorizePreview,
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
