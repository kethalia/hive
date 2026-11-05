import { describe, expect, it } from "vitest";
import { releaseBuildRoute } from "@/lib/delivery/release-build-route.server";
import type { ReleaseBuildStore } from "@/lib/delivery/release-build-store.server";

const make = (body: string, authorization = "fixture.jwt.token") =>
  new Request("https://example.test/api/internal/release-build/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hive-release-oidc": authorization },
    body,
  });
describe("release build endpoint adapter", () => {
  it("keeps an unconfigured controller unavailable and validates request bounds", async () => {
    expect((await releaseBuildRoute(make("{}"), "challenge", null)).status).toBe(404);
    const store = {
      challenge: async () => {
        throw Error("should not run");
      },
    } as unknown as ReleaseBuildStore;
    expect((await releaseBuildRoute(make("{}", "bad token"), "challenge", store)).status).toBe(401);
    expect(
      (
        await releaseBuildRoute(
          make(JSON.stringify({ data: "x".repeat(33000) })),
          "challenge",
          store,
        )
      ).status,
    ).toBe(503);
  });
  it("passes the bounded body and bearer to the trusted store without exposing failures", async () => {
    let seen: unknown;
    const store = {
      challenge: async (body: unknown, token: string) => {
        seen = { body, token };
        return { releaseId: "scope" };
      },
    } as unknown as ReleaseBuildStore;
    const response = await releaseBuildRoute(make('{"runId":"1"}'), "challenge", store);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ releaseId: "scope" });
    expect(seen).toEqual({ body: { runId: "1" }, token: "fixture.jwt.token" });
  });
});
