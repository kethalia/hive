import { describe, expect, it } from "vitest";
import { CloudflareReleaseObserver } from "@/lib/delivery/release-observer.server";

const config = {
  target: {
    accountId: "a".repeat(32),
    environment: "preview",
    hiveReleaseWriter: true,
    scripts: { app: "preview-app", auth: "preview-auth" },
  },
  origin: "https://preview.example.invalid",
  minimumRequests: 2,
  maxErrorRate: 0.1,
  settleDelayMs: 60000,
};
const secrets = {
  analyticsToken: "fixture",
  probeSecret: "b".repeat(64),
  previewBearer: "c".repeat(64),
};
const sourceSha = "d".repeat(40),
  artifactDigest = "e".repeat(64);
const state = {
  app: {
    deploymentId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    sourceSha,
    artifactDigest,
  },
  auth: {
    deploymentId: "00000000-0000-4000-8000-000000000003",
    versionId: "00000000-0000-4000-8000-000000000004",
    sourceSha,
    artifactDigest,
  },
};
const now = Date.now(),
  window = { ...state, startedAt: now - 120000, endedAt: now - 61000 };
const health = {
  schemaVersion: 1,
  app: { component: "app", sourceSha, artifactDigest, ready: true },
  auth: { component: "auth", sourceSha, artifactDigest, ready: true },
};
const metric = (requests: number, errors: number) => ({
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests, errors } }] }] } },
});
describe("release observation producer", () => {
  it("checks exact versions before/after, private health and both script metrics", async () => {
    const calls: string[] = [];
    const observer = new CloudflareReleaseObserver(
      config,
      secrets,
      async (component) => state[component],
      async (url, init) => {
        calls.push(String(url));
        expect(init?.redirect).toBe("error");
        if (String(url).includes(".well-known")) return Response.json(health);
        const body = JSON.parse(String(init?.body));
        expect([config.target.scripts.app, config.target.scripts.auth]).toContain(
          body.variables.script,
        );
        return Response.json(metric(100, 1));
      },
    );
    const result = await observer.observe(window, new AbortController().signal);
    expect(result.evidence).toMatchObject({ smoke: "passed", metrics: "passed" });
    expect(calls).toHaveLength(3);
  });
  it("holds on missing, stale, unhealthy or drifted observations", async () => {
    let reads = 0;
    const missing = new CloudflareReleaseObserver(
      config,
      secrets,
      async (component) => state[component],
      async (url) =>
        String(url).includes(".well-known") ? Response.json(health) : Response.json(metric(0, 0)),
    );
    await expect(missing.observe(window, new AbortController().signal)).rejects.toThrow(
      "release_metrics_unhealthy_or_incomplete",
    );
    await expect(
      missing.observe({ ...window, endedAt: Date.now() }, new AbortController().signal),
    ).rejects.toThrow("release_observation_window_unavailable");
    const drift = new CloudflareReleaseObserver(
      config,
      secrets,
      async (component) => ({
        ...state[component],
        deploymentId: ++reads > 2 ? state.auth.deploymentId : state[component].deploymentId,
      }),
      async (url) =>
        String(url).includes(".well-known") ? Response.json(health) : Response.json(metric(100, 0)),
    );
    await expect(drift.observe(window, new AbortController().signal)).rejects.toThrow(
      "release_observer_deployment_changed",
    );
    const unhealthy = new CloudflareReleaseObserver(
      config,
      secrets,
      async (component) => state[component],
      async (url) =>
        String(url).includes(".well-known")
          ? Response.json(health)
          : Response.json(metric(100, 20)),
    );
    expect((await unhealthy.observe(window, new AbortController().signal)).evidence.metrics).toBe(
      "failed",
    );
  });
  it("records an authenticated readiness 503 as a smoke failure without fabricating metrics", async () => {
    const observer = new CloudflareReleaseObserver(
      config,
      secrets,
      async (component) => state[component],
      async () => new Response(null, { status: 503 }),
    );
    expect((await observer.probe(window, new AbortController().signal))?.evidence).toMatchObject({
      smoke: "failed",
      metrics: "unknown",
      status: 503,
    });
  });
});

describe("single Worker observation", () => {
  it("checks both real health roles against one deployment and counts one metric stream", async () => {
    const single = {
      ...config,
      target: {
        ...config.target,
        environment: "production",
        topology: "single" as const,
        scripts: { app: "hive", auth: "hive" },
      },
    };
    const calls: string[] = [];
    expect(
      () =>
        new CloudflareReleaseObserver(
          { ...single, target: { ...single.target, environment: "preview" } },
          secrets,
          async () => {
            throw Error("must not read production");
          },
          async () => {
            throw Error("must not fetch");
          },
        ),
    ).toThrow("release_native_preview_unsupported");
    const observer = new CloudflareReleaseObserver(
      single,
      secrets,
      async () => state.app,
      async (url) => {
        calls.push(String(url));
        return String(url).includes(".well-known")
          ? Response.json(health)
          : Response.json(metric(100, 1));
      },
    );
    const result = await observer.observe(
      { ...window, auth: state.app },
      new AbortController().signal,
    );
    expect(result.evidence).toMatchObject({
      topology: "single",
      metrics: "passed",
      analytics: { worker: { requests: 100, errors: 1 } },
    });
    expect(calls).toHaveLength(2);
    await expect(observer.observe(window, new AbortController().signal)).rejects.toThrow(
      "release_observer_deployment_changed",
    );
  });
});
