import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNativeWorker } from "./composition.mjs";
import { deploymentPlan } from "./deploy.mjs";

const config = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url)));
const profiles = JSON.parse(await readFile(new URL("./preview-profiles.json", import.meta.url)));
const branch = "codex/cloudflare-foundation";
const origin = profiles[branch].origin;
const context = { waitUntil() {}, passThroughOnException() {} };
const env = {
  ...config.previews.vars,
  DATABASE_URL: "postgresql://hive_foundation_runtime:fixture@localhost/hive_foundation_preview",
};

test("connected preview deployment admits its reviewed profile", () => {
  assert.equal(deploymentPlan("preview", branch, config, profiles).origin, origin);
  assert.throws(() => deploymentPlan("preview", "main", config, profiles));
  assert.throws(() => deploymentPlan("production", "main", config, profiles));
  const changed = structuredClone(config);
  changed.previews.vars.HIVE_DATABASE_NAME = "hive_native_preview";
  assert.throws(() => deploymentPlan("preview", branch, changed, profiles));
});

test("inherited database credentials hold before authentication or application I/O", async () => {
  let calls = 0;
  const handler = {
    fetch() {
      calls++;
      return new Response("unexpected");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  const request = new Request(origin);
  for (const url of [
    undefined,
    "postgresql://owner:fixture@localhost/hive_native_preview",
    "postgresql://owner:fixture@localhost/hive_foundation_preview",
  ]) {
    assert.equal((await worker.fetch(request, { ...env, DATABASE_URL: url }, context)).status, 503);
  }
  assert.equal(calls, 0);
});

test("authentication composition retains each request environment across interleaved requests", async () => {
  const worker = createNativeWorker({
    app: {
      async fetch(_request, local) {
        await Promise.resolve();
        return local.AUTH_SERVICE.fetch("https://auth.internal/health");
      },
    },
    auth: {
      fetch(_request, local) {
        return new Response(local.AUTH_SERVICE_SECRET);
      },
    },
  });
  const [a, b] = await Promise.all([
    worker.fetch(new Request(origin), { ...env, AUTH_SERVICE_SECRET: "request-a" }, context),
    worker.fetch(new Request(origin), { ...env, AUTH_SERVICE_SECRET: "request-b" }, context),
  ]);
  assert.deepEqual(await Promise.all([a.text(), b.text()]), ["request-a", "request-b"]);
});

test("bootstrap and mismatched preview origins hold", async () => {
  const handler = {
    fetch() {
      throw Error("Unexpected application dispatch");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  assert.equal(
    (await worker.fetch(new Request(origin), { ...env, HIVE_NATIVE_MODE: "bootstrap" }, context))
      .status,
    503,
  );
  assert.equal(
    (await worker.fetch(new Request("https://other.example/"), env, context)).status,
    403,
  );
});
