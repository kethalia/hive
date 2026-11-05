import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeWorker } from "./composition.mjs";

function fixture() {
  const calls = [];
  const auth = {
    async fetch(request, env) {
      calls.push({ service: "auth", tenant: env.tenant, signalAborted: request.signal.aborted });
      if (request.headers.get("authorization") !== `Bearer ${env.AUTH_SERVICE_SECRET}`)
        return new Response("denied", { status: 403 });
      return new Response(`${env.tenant}:${await request.text()}`);
    },
    async scheduled(_event, env) {
      calls.push({ service: "auth-cron", tenant: env.tenant });
    },
  };
  const app = {
    async fetch(request, env) {
      calls.push({ service: "app", tenant: env.tenant });
      if (["/internal-probe", "/wrong-secret"].includes(new URL(request.url).pathname)) {
        const result = await env.AUTH_SERVICE.fetch("https://auth.internal/verify", {
          method: "POST",
          headers: {
            authorization: `Bearer ${new URL(request.url).pathname === "/wrong-secret" ? "wrong" : env.AUTH_SERVICE_SECRET}`,
          },
          body: env.tenant,
          signal: request.signal,
        });
        return result;
      }
      return new Response("app-only");
    },
    scheduled(_event, env, context) {
      context.waitUntil(
        Promise.resolve().then(() => calls.push({ service: "app-cron", tenant: env.tenant })),
      );
    },
  };
  const jobs = {
    async fetch() {
      throw Error("not a public router");
    },
    async scheduled(_event, env) {
      calls.push({ service: "jobs-cron", tenant: env.tenant });
      const response = await env.APP_SERVICE.fetch("https://app.internal/anything");
      assert.equal(await response.text(), "app-only");
    },
  };
  return { worker: createNativeWorker({ app, auth, jobs }), calls };
}
const context = () => {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
  };
};

test("inactive production and unspecified environments never dispatch", async () => {
  const { worker, calls } = fixture();
  for (const env of [{}, { HIVE_NATIVE_MODE: "production" }, { HIVE_NATIVE_MODE: "preview" }]) {
    const ctx = context();
    const res = await worker.fetch(new Request("https://example.invalid"), env, ctx);
    assert.equal(res.status, 503);
    worker.scheduled({}, env, ctx);
    assert.equal(ctx.pending.length, 0);
  }
  assert.deepEqual(calls, []);
});

test("public requests enter app only and invocation-local adapters preserve headers, body and signal", async () => {
  const { worker, calls } = fixture();
  const ctrl = new AbortController();
  const env = (tenant) => ({
    HIVE_NATIVE_MODE: "preview",
    HIVE_NATIVE_PREVIEW_ENABLED: "true",
    tenant,
    AUTH_SERVICE_SECRET: tenant,
    AUTH_SERVICE: {
      fetch() {
        throw Error("external binding used");
      },
    },
  });
  const [a, b] = await Promise.all(
    ["a", "b"].map((tenant) =>
      worker.fetch(
        new Request("https://example.invalid/internal-probe", { signal: ctrl.signal }),
        env(tenant),
        context(),
      ),
    ),
  );
  assert.deepEqual(await Promise.all([a.text(), b.text()]), ["a:a", "b:b"]);
  assert.deepEqual(
    calls.filter((c) => c.service === "auth").map((c) => [c.tenant, c.signalAborted]),
    [
      ["a", false],
      ["b", false],
    ],
  );
  const res = await worker.fetch(
    new Request("https://example.invalid/auth/internal"),
    env("a"),
    context(),
  );
  assert.equal(await res.text(), "app-only");
  assert.equal(calls.filter((c) => c.service === "auth").length, 2);
  const denied = await worker.fetch(
    new Request("https://example.invalid/wrong-secret"),
    env("a"),
    context(),
  );
  assert.equal(denied.status, 403);
  ctrl.abort();
  await worker.fetch(
    new Request("https://example.invalid/internal-probe", { signal: ctrl.signal }),
    env("a"),
    context(),
  );
  assert.equal(calls.filter((c) => c.service === "auth").at(-1).signalAborted, true);
});

test("only active production schedules all handlers with local service adapter", async () => {
  const { worker, calls } = fixture();
  const preview = context();
  worker.scheduled(
    { cron: "*/5 * * * *" },
    { HIVE_NATIVE_MODE: "preview", HIVE_NATIVE_PREVIEW_ENABLED: "true" },
    preview,
  );
  assert.equal(preview.pending.length, 0);
  for (const event of [{}, { cron: "0 * * * *" }, { cron: "* * * * *" }]) {
    const other = context();
    worker.scheduled(
      event,
      { HIVE_NATIVE_MODE: "production", HIVE_NATIVE_PRODUCTION_ACTIVE: "true" },
      other,
    );
    assert.equal(other.pending.length, 0);
  }
  const ctx = context();
  worker.scheduled(
    { cron: "*/5 * * * *" },
    {
      HIVE_NATIVE_MODE: "production",
      HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
      tenant: "prod",
    },
    ctx,
  );
  await Promise.all(ctx.pending);
  await Promise.all(ctx.pending);
  assert.deepEqual(calls.map((x) => x.service).sort(), [
    "app",
    "app-cron",
    "auth-cron",
    "jobs-cron",
  ]);
  assert.ok(calls.every((x) => x.tenant === "prod"));
});

test("a scheduled failure waits for other handlers to settle before rejecting", async () => {
  let finish;
  let settled = false;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const handler = { fetch: async () => new Response() };
  const worker = createNativeWorker({
    app: { ...handler, scheduled() {} },
    auth: {
      ...handler,
      async scheduled() {
        throw Error("private failure");
      },
    },
    jobs: {
      ...handler,
      async scheduled() {
        await pending;
        settled = true;
      },
    },
  });
  const ctx = context();
  worker.scheduled(
    { cron: "*/5 * * * *" },
    { HIVE_NATIVE_MODE: "production", HIVE_NATIVE_PRODUCTION_ACTIVE: "true" },
    ctx,
  );
  let done = false;
  const result = ctx.pending[0].then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(done, false);
  finish();
  await assert.rejects(ctx.pending[0], /^Error: Scheduled dispatch unavailable$/);
  await result;
  assert.equal(settled, true);
});
