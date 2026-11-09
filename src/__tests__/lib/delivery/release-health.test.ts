import { describe, expect, it } from "vitest";
import {
  RELEASE_HEALTH_PATH,
  releaseAuthReadiness,
  releaseHealth,
} from "../../../../deploy/cloudflare/app/release-health";

const secret = "a".repeat(64),
  source = "b".repeat(40),
  artifact = "c".repeat(64);
const env = {
  HIVE_RELEASE_HEALTH_ENABLED: "true",
  HIVE_RELEASE_PROBE_SECRET: secret,
  HIVE_RELEASE_SOURCE_SHA: source,
  HIVE_RELEASE_ARTIFACT_DIGEST: artifact,
};
const request = (token = secret) =>
  new Request(`https://example.invalid${RELEASE_HEALTH_PATH}`, {
    headers: { "X-Hive-Release-Probe": token },
  });
describe("private release readiness", () => {
  it("requires enabled probe and secret before touching dependencies", async () => {
    let calls = 0;
    const ready = async () => {
      calls++;
      return true;
    };
    expect(
      (
        await releaseHealth(
          request(),
          { ...env, HIVE_RELEASE_HEALTH_ENABLED: "false" },
          "auth",
          ready,
        )
      ).status,
    ).toBe(404);
    expect((await releaseHealth(request("wrong"), env, "auth", ready)).status).toBe(401);
    expect(calls).toBe(0);
  });
  it("requires database and authenticated service binding readiness", async () => {
    const auth = { component: "auth", sourceSha: source, artifactDigest: artifact, ready: true };
    const ok = await releaseHealth(
      request(),
      env,
      "app",
      async () => true,
      async () => auth,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      schemaVersion: 1,
      app: { component: "app", ready: true },
      auth,
    });
    expect(
      (
        await releaseHealth(
          request(),
          env,
          "app",
          async () => false,
          async () => auth,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await releaseHealth(
          request(),
          env,
          "app",
          async () => true,
          async () => ({ ...auth, ready: false }),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await releaseHealth(
          request(),
          { ...env, HIVE_RELEASE_SOURCE_SHA: "bad" },
          "auth",
          async () => true,
        )
      ).status,
    ).toBe(503);
  });
  it("aborts a stalled auth response body within the shared fetch-and-read deadline", async () => {
    let canceled = false,
      observedSignal: AbortSignal | undefined;
    const started = Date.now();
    await expect(
      releaseAuthReadiness(
        async (request) => {
          observedSignal = request.signal;
          return new Response(
            new ReadableStream({
              start() {},
              cancel() {
                canceled = true;
              },
            }),
          );
        },
        secret,
        new AbortController().signal,
        250,
      ),
    ).rejects.toThrow("release_probe_aborted");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(observedSignal?.aborted).toBe(true);
    expect(canceled).toBe(true);
  });
  it("propagates client abort even when auth fetch never resolves", async () => {
    const client = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const pending = releaseAuthReadiness(
      async (request) => {
        observedSignal = request.signal;
        return new Promise<Response>(() => {});
      },
      secret,
      client.signal,
      1000,
    );
    await Promise.resolve();
    client.abort();
    await expect(pending).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });
  it("does not start a dependency if the client aborts before its microtask", async () => {
    const client = new AbortController();
    let calls = 0;
    const pending = releaseAuthReadiness(
      async () => {
        calls++;
        return new Response();
      },
      secret,
      client.signal,
      1000,
    );
    client.abort();
    await expect(pending).rejects.toThrow("release_probe_aborted");
    expect(calls).toBe(0);
  });
  it("does not invoke auth when the client was already aborted", async () => {
    const client = new AbortController();
    client.abort();
    let calls = 0;
    await expect(
      releaseAuthReadiness(
        async () => {
          calls++;
          return new Response();
        },
        secret,
        client.signal,
        30,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
