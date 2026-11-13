import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNativeWorker } from "./composition.mjs";
import { deploymentArguments, deploymentPlan } from "./deploy.mjs";

const config = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url)));
const profiles = JSON.parse(await readFile(new URL("./preview-profiles.json", import.meta.url)));
const branch = "codex/hive-production-cutover";
const origin = profiles[branch].origin;
const context = { waitUntil() {}, passThroughOnException() {} };
const env = {
  ...config.previews.vars,
  DATABASE_URL: "postgresql://hive_foundation_runtime:fixture@localhost/hive_foundation_preview",
};

test("connected preview deployment admits its reviewed profile", () => {
  assert.equal(deploymentPlan("preview", branch, config, profiles).origin, origin);
  assert.throws(() => deploymentPlan("preview", "main", config, profiles));
  assert.throws(() => deploymentPlan("preview", "unreviewed", config, profiles));
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

const productionEnv = {
  ...config.vars,
  DATABASE_URL: "postgresql://hive_production_runtime:fixture@localhost/hive_production",
};
const productionOrigin = "https://hive.kethalia.com";

test("production deploys main through Wrangler deploy and Preview uses its named command", () => {
  const production = deploymentPlan("production", "main", config, profiles);
  assert.equal(production.origin, productionOrigin);
  assert.equal(production.databaseName, "hive_production");
  assert.deepEqual(deploymentArguments("production", production, "config.jsonc"), [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "config.jsonc",
  ]);
  const preview = deploymentPlan("preview", branch, config, profiles);
  assert.deepEqual(deploymentArguments("preview", preview, "config.jsonc"), [
    "exec",
    "wrangler",
    "preview",
    "--config",
    "config.jsonc",
    "--name",
    branch,
  ]);
  assert.throws(() => deploymentPlan("production", branch, config, profiles));
  assert.throws(() => deploymentPlan("unknown", "main", config, profiles));
});

test("production plan enforces the domain, database, role, existing secrets and runtime", () => {
  for (const [key, value] of [
    ["HIVE_NATIVE_MODE", "bootstrap"],
    ["HIVE_PUBLIC_ORIGIN", origin],
    ["HIVE_DATABASE_NAME", "hive_foundation_preview"],
    ["HIVE_DATABASE_ROLE", "hive_foundation_runtime"],
    ["HIVE_RUNTIME_TARGET", "node"],
    ["CODER_URL", "https://other.example"],
  ]) {
    const changed = structuredClone(config);
    changed.vars[key] = value;
    assert.throws(() => deploymentPlan("production", "main", changed, profiles), key);
  }
  for (const change of [
    (c) => {
      c.routes = [];
    },
    (c) => {
      c.previews.routes = c.routes;
    },
    (c) => {
      c.secrets.required.pop();
    },
    (c) => {
      c.services = [{ binding: "AUTH_SERVICE", service: "another" }];
    },
  ]) {
    const changed = structuredClone(config);
    change(changed);
    assert.throws(() => deploymentPlan("production", "main", changed, profiles));
  }
});

test("production authentication composes inside its admitted request environment", async () => {
  const worker = createNativeWorker({
    app: {
      fetch(_request, local) {
        return local.AUTH_SERVICE.fetch("https://auth.internal/health");
      },
    },
    auth: {
      fetch(_request, local) {
        return new Response(local.HIVE_DATABASE_NAME);
      },
    },
  });
  const response = await worker.fetch(new Request(productionOrigin), productionEnv, context);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hive_production");
  assert.equal((await worker.fetch(new Request(origin), productionEnv, context)).status, 403);
});

test("runtime rejects cross-environment credentials and production-origin substitution before dispatch", async () => {
  let calls = 0;
  const handler = {
    fetch() {
      calls++;
      return new Response("unexpected");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  for (const changed of [
    { ...productionEnv, DATABASE_URL: env.DATABASE_URL },
    { ...env, DATABASE_URL: productionEnv.DATABASE_URL },
    {
      ...productionEnv,
      HIVE_DATABASE_NAME: env.HIVE_DATABASE_NAME,
      HIVE_DATABASE_ROLE: env.HIVE_DATABASE_ROLE,
      DATABASE_URL: env.DATABASE_URL,
    },
    { ...env, HIVE_PUBLIC_ORIGIN: productionOrigin },
    { ...productionEnv, HIVE_PUBLIC_ORIGIN: origin },
    { ...productionEnv, DATABASE_URL: "postgresql://owner:fixture@localhost/hive_production" },
  ]) {
    const response = await worker.fetch(new Request(changed.HIVE_PUBLIC_ORIGIN), changed, context);
    assert.equal(response.status, 503);
  }
  assert.equal(calls, 0);
});

const alias = "https://codex-hive-production-cutover-hive.b00ste.workers.dev";

test("old preview GET and HEAD redirect to the exact canonical origin without application I/O", async () => {
  let calls = 0;
  const handler = {
    fetch() {
      calls++;
      return new Response("unexpected");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      new Request(`${alias}//other.example/workspaces?id=a%2Fb&next=https%3A%2F%2Fevil.example`, {
        method,
      }),
      env,
      context,
    );
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      `${origin}//other.example/workspaces?id=a%2Fb&next=https%3A%2F%2Fevil.example`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
  assert.equal(calls, 0);
});

test("preview alias denies writes, upgrades, lookalike hosts and production requests", async () => {
  const handler = {
    fetch() {
      throw Error("Unexpected application dispatch");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  for (const request of [
    new Request(alias, { method: "POST" }),
    new Request(alias, { method: "PUT" }),
    new Request(alias, { method: "DELETE" }),
    new Request(alias, { headers: { Upgrade: "websocket" } }),
    new Request(alias, { method: "HEAD", headers: { Upgrade: "websocket" } }),
    new Request("http://codex-hive-production-cutover-hive.b00ste.workers.dev/"),
    new Request(`${alias}.evil.example/`),
    new Request("https://other.hive-preview.kethalia.com/"),
  ]) {
    assert.equal((await worker.fetch(request, env, context)).status, 403);
  }
  assert.equal((await worker.fetch(new Request(alias), productionEnv, context)).status, 403);
});

test("alias configuration is exact, HTTPS and preview-only at source and runtime boundaries", async () => {
  const handler = {
    fetch() {
      throw Error("Unexpected application dispatch");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  for (const value of [
    undefined,
    "https://other.example",
    `${alias}/`,
    alias.replace("https:", "http:"),
  ]) {
    const changed = structuredClone(config);
    changed.previews.vars.HIVE_PREVIEW_ORIGIN_ALIAS = value;
    assert.throws(() => deploymentPlan("preview", branch, changed, profiles));
    if (value !== undefined) {
      assert.equal(
        (
          await worker.fetch(
            new Request(alias),
            { ...env, HIVE_PREVIEW_ORIGIN_ALIAS: value },
            context,
          )
        ).status,
        503,
      );
    }
  }
  const changed = structuredClone(config);
  changed.vars.HIVE_PREVIEW_ORIGIN_ALIAS = alias;
  assert.throws(() => deploymentPlan("production", "main", changed, profiles));
  assert.equal(
    (
      await worker.fetch(
        new Request(productionOrigin),
        { ...productionEnv, HIVE_PREVIEW_ORIGIN_ALIAS: alias },
        context,
      )
    ).status,
    503,
  );
  for (const field of ["enabled", "previews_enabled"]) {
    const changed = structuredClone(config);
    changed.routes[1][field] = !changed.routes[1][field];
    assert.throws(() => deploymentPlan("preview", branch, changed, profiles));
  }
});
