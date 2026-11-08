import { describe, expect, it } from "vitest";
import { automaticWorkerHealth } from "../../../../deploy/cloudflare/app/automatic-health";

const nonce = "00000000-0000-4000-8000-000000000001";
const build = {
  schemaVersion: 1,
  status: "available",
  provider: "cloudflare-builds",
  sourceSha: "a".repeat(40),
  buildUuid: nonce,
  branch: "main",
};
const env = {
  HIVE_NATIVE_HEALTH_ENABLED: "true",
  HIVE_NATIVE_MODE: "production",
  HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
  HIVE_PUBLIC_ORIGIN: "https://hive.example.invalid",
  HIVE_NATIVE_BUILD_IDENTITY: build,
};
const request = (url = env.HIVE_PUBLIC_ORIGIN) =>
  new Request(`${url}/.well-known/hive-release-health`, {
    headers: { "X-Hive-Health-Nonce": nonce },
  });
describe("automatic native health with compiled provider identity", () => {
  it("binds exact origin/nonce and real DB/auth results without a second app/auth version", async () => {
    let calls = 0;
    const response = await automaticWorkerHealth(
      request(),
      env,
      async () => {
        calls++;
        return true;
      },
      async () => {
        calls++;
        return true;
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(await response.json()).toMatchObject({
      kind: "automatic-worker-health",
      nonce,
      build,
      readiness: { database: true, authentication: true },
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("holds unavailable/preview identities, wrong origin and failed actual readiness", async () => {
    for (const patch of [
      { HIVE_NATIVE_MODE: "preview" },
      {
        HIVE_NATIVE_BUILD_IDENTITY: {
          schemaVersion: 1,
          status: "unavailable",
          reason: "non_provider_build",
        },
      },
      { HIVE_NATIVE_BUILD_IDENTITY: { ...build, branch: "codex/preview" } },
      { HIVE_PUBLIC_ORIGIN: "https://other.invalid" },
    ])
      expect(
        (
          await automaticWorkerHealth(
            request(),
            { ...env, ...patch },
            async () => true,
            async () => true,
          )
        ).status,
      ).toBe(503);
    expect(
      (
        await automaticWorkerHealth(
          request(),
          env,
          async () => false,
          async () => true,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await automaticWorkerHealth(
          request(),
          env,
          async () => true,
          async () => false,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await automaticWorkerHealth(
          request(),
          { ...env, HIVE_NATIVE_HEALTH_ENABLED: undefined },
          async () => true,
          async () => true,
        )
      ).status,
    ).toBe(404);
  });
});
