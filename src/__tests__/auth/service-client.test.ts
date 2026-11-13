import { afterEach, expect, it, vi } from "vitest";

const binding = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { AUTH_SERVICE: binding, AUTH_SERVICE_SECRET: "a".repeat(64) },
  }),
}));

import { getAuthServiceClient } from "@/lib/auth/service-client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("the Cloudflare factory supplies a 30-second login budget and 10-second session budget", async () => {
  vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
  const deadline = vi.spyOn(AbortSignal, "timeout");
  binding.fetch.mockImplementation(async () =>
    Response.json({ sessionId: "fixture", applicationsHost: "" }),
  );
  const client = getAuthServiceClient();
  await client.login({
    coderUrl: "https://coder.example.com",
    email: "fixture@example.com",
    password: "fixture",
  });
  expect(deadline).toHaveBeenLastCalledWith(30_000);
  await client.getSession("fixture");
  expect(deadline).toHaveBeenLastCalledWith(10_000);
});
