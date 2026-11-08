import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => local.db,
}));
// Only the network database adapter is redirected to the owned loopback fixture.
// Both app/auth domain reads use the actual local PostgreSQL client and schema.
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: () => ({
    run: <T>(operation: () => T) => operation(),
    close: async () => {},
  }),
}));

import { createAppWorker } from "../../../../deploy/cloudflare/app/composition";
import auth from "../../../../deploy/cloudflare/auth/worker";
import { createNativeWorker } from "../../../../deploy/cloudflare/native/composition.mjs";

const url = process.env.HIVE_AUTOMATIC_RELEASE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/hive_acceptance_test_automatic_[a-z0-9_]+$/.test(new URL(url).pathname))
)
  throw Error("Owned local fixture database only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test_automatic_unused",
});
local.db = db;
afterAll(() => db.$disconnect());
describe.skipIf(!url)("actual app/native/auth health composition", () => {
  it("requires authenticated auth-domain config, crypto and schema readiness and ignores a runtime build spoof", async () => {
    const build = {
      schemaVersion: 1 as const,
      status: "available" as const,
      provider: "cloudflare-builds" as const,
      sourceSha: "8".repeat(40),
      buildUuid: "00000000-0000-4000-8000-000000000001",
      branch: "main",
    };
    const app = createAppWorker(
      {
        async fetch() {
          throw Error("No framework fallback");
        },
      },
      { schemaVersion: 1, actions: {} },
    );
    const worker = createNativeWorker({
      app,
      auth,
      jobs: {
        async fetch() {
          throw Error("No jobs");
        },
        scheduled() {},
      },
      buildIdentity: build,
    });
    const base = {
      HIVE_NATIVE_MODE: "production",
      HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
      HIVE_NATIVE_HEALTH_ENABLED: "true",
      HIVE_PUBLIC_ORIGIN: "https://hive.example.invalid",
      HIVE_CODER_OAUTH_ENABLED: "true",
      CODER_URL: "https://coder.example.invalid",
      HIVE_CODER_OAUTH_CLIENT_ID: "fixture-client",
      HIVE_CODER_OAUTH_CLIENT_SECRET: "fixture-secret",
      ENCRYPTION_KEY: "a".repeat(64),
      COOKIE_SECRET: "b".repeat(64),
      AUTH_SERVICE_SECRET: "c".repeat(64),
      HIVE_NATIVE_BUILD_IDENTITY: { ...build, sourceSha: "0".repeat(40) },
    };
    const read = async (patch: Record<string, unknown> = {}) => {
      const tasks: Promise<unknown>[] = [],
        response = await worker.fetch(
          new Request(`${base.HIVE_PUBLIC_ORIGIN}/.well-known/hive-release-health`, {
            headers: { "X-Hive-Health-Nonce": build.buildUuid },
          }),
          { ...base, ...patch },
          {
            waitUntil(work: Promise<unknown>) {
              tasks.push(work);
            },
            passThroughOnException() {},
          },
        );
      const body = await response.text();
      await Promise.allSettled(tasks);
      return { status: response.status, body };
    };
    const healthy = await read();
    expect(healthy.status).toBe(200);
    expect(JSON.parse(healthy.body)).toMatchObject({
      build,
      readiness: { database: true, authentication: true },
    });
    for (const patch of [
      { ENCRYPTION_KEY: undefined },
      { ENCRYPTION_KEY: "malformed" },
      { HIVE_CODER_OAUTH_CLIENT_ID: undefined },
      { HIVE_CODER_OAUTH_CLIENT_SECRET: undefined },
      { HIVE_CODER_OAUTH_ENABLED: "false" },
      { CODER_URL: "http://insecure.invalid" },
      { COOKIE_SECRET: undefined },
      { AUTH_SERVICE_SECRET: "invalid" },
    ])
      expect((await read(patch)).status).toBe(503);
    // Public liveness remains deliberately weaker than authenticated readiness.
    const tasks: Promise<unknown>[] = [],
      response = await auth.fetch(new Request("https://auth.internal/readiness"), base, {
        waitUntil(work: Promise<unknown>) {
          tasks.push(work);
        },
        passThroughOnException() {},
      });
    expect(response.status).toBe(401);
    await response.text();
    await Promise.allSettled(tasks);
  }, 15000);
});
