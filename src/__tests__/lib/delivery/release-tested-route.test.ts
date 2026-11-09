import { expect, it } from "vitest";
import { releaseTestRoute } from "@/lib/delivery/release-tested-route.server";
import type { ReleaseTestStore } from "@/lib/delivery/release-tested-store.server";

it("keeps tested-tree issuer disabled unless installed and routes only bounded signed requests", async () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example.invalid/api/internal/release-tested/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ exact: true }),
    });
  expect((await releaseTestRoute(request(), "challenge", null)).status).toBe(404);
  const store = {
    challenge: async (value: unknown, token: string) => ({ value, token }),
  } as unknown as ReleaseTestStore;
  expect((await releaseTestRoute(request(), "challenge", store)).status).toBe(401);
  expect(
    (
      await releaseTestRoute(
        request({ "x-hive-release-oidc": "signed.token", "content-length": "32769" }),
        "challenge",
        store,
      )
    ).status,
  ).toBe(413);
  const response = await releaseTestRoute(
    request({ "x-hive-release-oidc": "signed.token" }),
    "challenge",
    store,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ value: { exact: true }, token: "signed.token" });
});
