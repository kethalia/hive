import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNativeWorker } from "./composition.mjs";
import { deploymentArguments, deploymentPlan } from "./deploy.mjs";

const config = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url)));
const profiles = JSON.parse(await readFile(new URL("./preview-profiles.json", import.meta.url)));
const branch = "codex/hive-production-cutover";
const profile = profiles[branch];
const origin = profile.origin;
const previewConfig = structuredClone(config);
Object.assign(previewConfig.previews.vars, {
  HIVE_PUBLIC_ORIGIN: origin,
  HIVE_DATABASE_NAME: profile.databaseName,
  HIVE_DATABASE_ROLE: profile.databaseRole,
  HIVE_PREVIEW_ORIGIN_ALIAS: profile.alias,
});
const context = { waitUntil() {}, passThroughOnException() {} };
const env = {
  ...previewConfig.previews.vars,
  DATABASE_URL: "postgresql://hive_foundation_runtime:fixture@localhost/hive_foundation_preview",
};

test("connected preview deployment admits its reviewed profile", () => {
  assert.equal(deploymentPlan("preview", branch, previewConfig, profiles).origin, origin);
  assert.throws(() => deploymentPlan("preview", "main", config, profiles));
  assert.throws(() => deploymentPlan("preview", "unreviewed", config, profiles));
  const changed = structuredClone(previewConfig);
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
  const preview = deploymentPlan("preview", branch, previewConfig, profiles);
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
    const changed = structuredClone(previewConfig);
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
    const changed = structuredClone(previewConfig);
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

test("generated deployment URLs redirect safe page loads to the branch preview", async () => {
  const handler = {
    fetch() {
      throw Error("Unexpected application dispatch");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  for (const generated of [
    "https://3656a995.hive-preview.kethalia.com",
    "https://3656a995-hive.b00ste.workers.dev",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request(`${generated}//other.example/workspaces?next=a%2Fb`, { method }),
        env,
        context,
      );
      assert.equal(response.status, 307);
      assert.equal(
        response.headers.get("location"),
        `${origin}//other.example/workspaces?next=a%2Fb`,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "");
    }
    for (const init of [{ method: "POST" }, { headers: { Upgrade: "websocket" } }]) {
      assert.equal((await worker.fetch(new Request(generated, init), env, context)).status, 403);
    }
    assert.equal((await worker.fetch(new Request(generated), productionEnv, context)).status, 403);
    const unconfigured = { ...env };
    delete unconfigured.HIVE_PREVIEW_ORIGIN_ALIAS;
    assert.equal((await worker.fetch(new Request(generated), unconfigured, context)).status, 403);
  }
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
    new Request("https://3656a995.hive-preview.kethalia.com.evil.example/"),
    new Request("https://3656a995-other.b00ste.workers.dev/"),
    new Request("https://3656a995.hive-preview.kethalia.com:8443/"),
    new Request("https://3656a99.hive-preview.kethalia.com/"),
    new Request("https://3656a9950.hive-preview.kethalia.com/"),
    new Request("http://3656a995.hive-preview.kethalia.com/"),
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
    const changed = structuredClone(previewConfig);
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
  const changed = structuredClone(previewConfig);
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
    const changed = structuredClone(previewConfig);
    changed.routes[1][field] = !changed.routes[1][field];
    assert.throws(() => deploymentPlan("preview", branch, changed, profiles));
  }
});

const oauthBranch = "codex/coder-oauth-better-auth";
const oauthProfile = profiles[oauthBranch];
const oauthConfig = structuredClone(config);
Object.assign(oauthConfig.previews.vars, {
  HIVE_PUBLIC_ORIGIN: oauthProfile.origin,
  HIVE_PREVIEW_ORIGIN_ALIAS: oauthProfile.alias,
  HIVE_DATABASE_NAME: oauthProfile.databaseName,
  HIVE_DATABASE_ROLE: oauthProfile.databaseRole,
});
const oauthEnv = {
  ...oauthConfig.previews.vars,
  DATABASE_URL: "postgresql://hive_coder_oauth_runtime:fixture@localhost/hive_coder_oauth_preview",
};

test("OAuth preview has an isolated reviewed profile and schema12", () => {
  assert.deepEqual(oauthProfile, {
    origin: "https://codex-coder-oauth-better-auth.hive-preview.kethalia.com",
    alias: "https://codex-coder-oauth-better-auth-hive.b00ste.workers.dev",
    databaseName: "hive_coder_oauth_preview",
    databaseRole: "hive_coder_oauth_runtime",
    schemaMigrations: 12,
    coderOAuthEnabled: true,
  });
  assert.equal(
    deploymentPlan("preview", oauthBranch, oauthConfig, profiles).origin,
    oauthProfile.origin,
  );
  assert.throws(() => deploymentPlan("preview", branch, config, profiles));
  assert.equal(deploymentPlan("preview", branch, previewConfig, profiles).origin, origin);
  assert.equal(config.vars.HIVE_CODER_OAUTH_ENABLED, "true");
  assert.equal(config.previews.vars.HIVE_CODER_OAUTH_ENABLED, "true");
  assert.ok(config.secrets.required.includes("CODER_OAUTH_CLIENT_SECRET"));
  assert.equal(config.vars.CODER_OAUTH_CLIENT_SECRET, undefined);
  assert.equal(config.previews.vars.CODER_OAUTH_CLIENT_SECRET, undefined);
});

test("historical foundation profile retains its exact database and origin when selected", () => {
  const foundation = profiles["codex/cloudflare-foundation"];
  const historical = structuredClone(config);
  Object.assign(historical.previews.vars, {
    HIVE_PUBLIC_ORIGIN: foundation.origin,
    HIVE_DATABASE_NAME: foundation.databaseName,
    HIVE_DATABASE_ROLE: foundation.databaseRole,
  });
  delete historical.previews.vars.HIVE_PREVIEW_ORIGIN_ALIAS;
  assert.equal(
    deploymentPlan("preview", "codex/cloudflare-foundation", historical, profiles).origin,
    foundation.origin,
  );
});

test("OAuth deployment holds mismatched or disabled profile settings", () => {
  for (const [key, value] of [
    ["HIVE_PUBLIC_ORIGIN", origin],
    ["HIVE_DATABASE_NAME", "hive_foundation_preview"],
    ["HIVE_DATABASE_ROLE", "hive_foundation_runtime"],
    ["HIVE_PREVIEW_ORIGIN_ALIAS", alias],
    ["HIVE_CODER_OAUTH_ENABLED", "false"],
  ]) {
    const changed = structuredClone(oauthConfig);
    changed.previews.vars[key] = value;
    assert.throws(() => deploymentPlan("preview", oauthBranch, changed, profiles), key);
  }
});

test("OAuth HTTP and auth bindings share only their exact reviewed database scope", async () => {
  let calls = 0;
  const worker = createNativeWorker({
    app: {
      fetch(_request, local) {
        calls++;
        return local.AUTH_SERVICE.fetch("https://auth.internal/health");
      },
    },
    auth: {
      fetch(_request, local) {
        calls++;
        return new Response(local.HIVE_DATABASE_NAME);
      },
    },
  });
  const accepted = await worker.fetch(new Request(oauthProfile.origin), oauthEnv, context);
  assert.equal(await accepted.text(), "hive_coder_oauth_preview");
  assert.equal(calls, 2);
  for (const changed of [
    { ...oauthEnv, DATABASE_URL: env.DATABASE_URL },
    { ...env, DATABASE_URL: oauthEnv.DATABASE_URL },
    { ...oauthEnv, DATABASE_URL: productionEnv.DATABASE_URL },
    { ...oauthEnv, HIVE_DATABASE_NAME: "hive_foundation_preview" },
    { ...oauthEnv, HIVE_DATABASE_ROLE: "hive_foundation_runtime" },
    { ...oauthEnv, HIVE_PUBLIC_ORIGIN: "https://unreviewed.example" },
    { ...oauthEnv, HIVE_PREVIEW_ORIGIN_ALIAS: alias },
  ])
    assert.equal(
      (await worker.fetch(new Request(changed.HIVE_PUBLIC_ORIGIN), changed, context)).status,
      503,
    );
  assert.equal(calls, 2);
});

test("OAuth preview redirects only safe alias loads to its exact canonical origin", async () => {
  const handler = {
    fetch() {
      throw Error("Unexpected application dispatch");
    },
  };
  const worker = createNativeWorker({ app: handler, auth: handler });
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(
      new Request(`${oauthProfile.alias}/login?returnTo=%2F`, { method }),
      oauthEnv,
      context,
    );
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), `${oauthProfile.origin}/login?returnTo=%2F`);
  }
  for (const init of [{ method: "POST" }, { headers: { Upgrade: "websocket" } }])
    assert.equal(
      (await worker.fetch(new Request(oauthProfile.alias, init), oauthEnv, context)).status,
      403,
    );
  for (const foreign of [alias, origin, `${oauthProfile.alias}.evil.example`])
    assert.equal((await worker.fetch(new Request(foreign), oauthEnv, context)).status, 403);
  assert.equal(
    (await worker.fetch(new Request(oauthProfile.alias), productionEnv, context)).status,
    403,
  );
});

test("Accounts preview enforces its dedicated bridge configuration and current package pins", () => {
  const accountsBranch = "codex/workspace-accounts-p03";
  const accounts = profiles[accountsBranch];
  assert.equal(deploymentPlan("preview", accountsBranch, config, profiles).origin, accounts.origin);
  assert.equal(accounts.schemaMigrations, 12);
  assert.equal(accounts.databaseName, "hive_workspace_accounts_preview");
  assert.ok(config.secrets.required.includes("HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY"));
  assert.equal(config.previews.secrets, undefined);
  for (const [key, value] of [
    ["HIVE_CODEX_ACCOUNTS_ENABLED", "false"],
    ["HIVE_CLAUDE_ACCOUNTS_ENABLED", "false"],
    ["HIVE_AGENT_TOOLS_TRANSPORT", "ssh"],
    ["HIVE_WORKSPACE_ISSUER_MODE", "shared-host"],
    ["HIVE_AGENT_TOOLS_HIVE_ORIGIN", "https://hive.kethalia.com"],
    ["HIVE_AGENT_TOOLS_ISSUER_KEY_ID", ""],
    ["HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY", "plaintext-private-key"],
    ["HIVE_AGENT_TOOLS_PINS_JSON", "[]"],
  ]) {
    const changed = structuredClone(config);
    changed.previews.vars[key] = value;
    assert.throws(() => deploymentPlan("preview", accountsBranch, changed, profiles), key);
  }
  for (const key of ["manifestSha256", "helperSha256"]) {
    const changed = structuredClone(config);
    const pins = JSON.parse(changed.previews.vars.HIVE_AGENT_TOOLS_PINS_JSON);
    pins[0][key] = "0".repeat(64);
    changed.previews.vars.HIVE_AGENT_TOOLS_PINS_JSON = JSON.stringify(pins);
    assert.throws(() => deploymentPlan("preview", accountsBranch, changed, profiles), key);
  }
});
