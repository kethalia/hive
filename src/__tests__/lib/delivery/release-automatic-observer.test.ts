import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { automaticReleaseConfigSchema } from "@/lib/delivery/release-automatic-contracts";
import { observeAutomaticBuild } from "@/lib/delivery/release-automatic-observer.server";

const sha = "a".repeat(40),
  buildUuid = randomUUID();
const config = automaticReleaseConfigSchema.parse({
  mode: "automatic-main-builds",
  policy: {
    schemaVersion: 1,
    purpose: "automatic_production",
    versionId: randomUUID(),
    ownerId: randomUUID(),
    repositoryId: "123",
    providerAccountId: "456",
    baseBranch: "main",
    method: "squash",
    validFrom: 1,
    expiresAt: Date.now() + 600000,
    cutoverApproval: { id: randomUUID(), approvedBy: "explicit-fixture", approvedAt: 0 },
    pipelineUsage: "existing-connected-builds",
  },
  target: { accountId: "1".repeat(32), worker: "hive", origin: "https://hive.example.invalid" },
  risk: { owner: "fixture", name: "native", allowedPrefixes: ["src/"] },
  tested: {
    workflow: {
      audiencePrefix: "urn:hive:release-tested:fixture:",
      repositoryId: "123",
      repositoryOwnerId: "456",
      workflowRef: "fixture/native/.github/workflows/test.yml@fixed",
      workflowSha: "a".repeat(40),
      controlDigest: "b".repeat(64),
    },
    run: {
      repositoryId: "123",
      owner: "fixture",
      name: "native",
      workflowId: "61",
      testJobName: "Test",
    },
  },
  observation: { windowMs: 1000 },
});
function fixture(patch: Record<string, unknown> = {}, checkPatch: Record<string, unknown> = {}) {
  let calls = 0;
  const health: typeof fetch = async (url, init) => {
    expect(url).toBe(`${config.target.origin}/.well-known/hive-release-health`);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    calls++;
    return Response.json(
      {
        schemaVersion: 1,
        kind: "automatic-worker-health",
        origin: config.target.origin,
        worker: "hive",
        mode: "production",
        nonce: new Headers(init?.headers).get("X-Hive-Health-Nonce"),
        build: {
          schemaVersion: 1,
          status: "available",
          provider: "cloudflare-builds",
          sourceSha: sha,
          buildUuid,
          branch: "main",
        },
        readiness: { database: true, authentication: true },
        observedAt: new Date().toISOString(),
        ...patch,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };
  const read = async () => ({
    schemaVersion: 1,
    repositoryId: "123",
    sourceSha: sha,
    checks: [
      {
        id: "999",
        name: "Workers Builds: hive",
        headSha: sha,
        appId: "85455",
        appSlug: "cloudflare-workers-and-pages",
        buildUuid,
        status: "completed",
        conclusion: "success",
        detailsUrl: `https://dash.cloudflare.com/${config.target.accountId}/workers/services/view/hive/production/builds/${buildUuid}`,
        ...checkPatch,
      },
    ],
  });
  return { health, read, calls: () => calls };
}
describe("read-only existing automatic deployment observation", () => {
  it("binds actual provider app/check/source/build to two fresh same-origin readiness responses", async () => {
    const f = fixture();
    const result = await observeAutomaticBuild(
      config,
      sha,
      f.read,
      AbortSignal.timeout(1000),
      f.health,
    );
    expect(result.health.build.buildUuid).toBe(buildUuid);
    expect(result.check.id).toBe("999");
    expect(f.calls()).toBe(2);
  });
  it("rejects fake apps, preview checks, wrong source/build/origin, stale/cached replies and observed drift", async () => {
    for (const [healthPatch, checkPatch] of [
      [{ origin: "https://other.invalid" }, {}],
      [{ observedAt: new Date(Date.now() - 60000).toISOString() }, {}],
      [{ nonce: randomUUID() }, {}],
      [{}, { appId: "1" }],
      [{}, { appSlug: "other" }],
      [{}, { headSha: "b".repeat(40) }],
      [{}, { buildUuid: randomUUID() }],
      [{}, { conclusion: "failure" }],
      [
        {},
        {
          detailsUrl: `https://dash.cloudflare.com/${config.target.accountId}/workers/services/view/hive/production/previews/epic/builds/${buildUuid}`,
        },
      ],
    ] as [Record<string, unknown>, Record<string, unknown>][]) {
      const f = fixture(healthPatch, checkPatch);
      await expect(
        observeAutomaticBuild(config, sha, f.read, AbortSignal.timeout(1000), f.health),
      ).rejects.toThrow();
    }
    const f = fixture();
    let calls = 0;
    const drift: typeof fetch = async (...args) => {
      const response = await f.health(...args);
      if (++calls === 1) return response;
      const body = await response.json();
      body.build.buildUuid = randomUUID();
      return Response.json(body, { headers: { "Cache-Control": "no-store" } });
    };
    await expect(
      observeAutomaticBuild(config, sha, f.read, AbortSignal.timeout(1000), drift),
    ).rejects.toThrow("automatic_observation_drift");
  });
});
