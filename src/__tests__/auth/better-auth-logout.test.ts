import { afterEach, expect, it, vi } from "vitest";

const handler = vi.hoisted(() => vi.fn());
vi.mock("@hive/db", () => ({ getDb: () => ({}) }));
vi.mock("../../../services/auth/src/auth/better-auth", () => ({
  createCoderAuth: () => ({ handler }),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: async () => null }));
vi.mock("@/lib/auth/service-client", () => ({ getAuthServiceClient: () => ({}) }));

import { POST } from "@/app/api/auth/logout/route";

afterEach(() => vi.unstubAllEnvs());

it("preserves Better Auth cookie deletion alongside frame and legacy cookie deletion", async () => {
  const origin = "https://hive.oauth.invalid";
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  vi.stubEnv("NODE_ENV", "production");
  const expired = "__Host-hive-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
  handler.mockResolvedValue(
    Response.json({ success: true }, { headers: { "Set-Cookie": expired } }),
  );
  const response = await POST(
    new Request(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: origin, Cookie: "__Host-hive-auth=fixture" },
    }),
  );
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(cookies).toContain(expired);
  expect(cookies.some((value) => value.startsWith("hive-coder-host=;"))).toBe(true);
  expect(cookies.some((value) => value.startsWith("__Host-hive-session=;"))).toBe(true);
});
