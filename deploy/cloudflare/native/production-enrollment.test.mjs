import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { account, productionTarget, publicDigest } from "./production-configuration.mjs";
import {
  productionEnrollment,
  publishManagedProduction,
  verifyProductionParent,
  verifyRemoteMain,
} from "./production-enrollment.mjs";

const config = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url)));
const now = Date.parse("2026-11-08T12:00:00Z"),
  source = "a".repeat(40);
const tag = "b".repeat(32),
  createdOn = "2026-11-06T00:00:00Z";
const id = "10000000-0000-4000-8000-000000000001";
function fixture(mode = "first-cutover") {
  const configuration = {
    origin: "https://hive.kethalia.com",
    route: { pattern: "hive.kethalia.com/*", zone_id: productionTarget.zoneId },
    oauthEnrollment: {
      coderOrigin: "https://coder.kethalia.com",
      clientId: "0a4e5cd5-cf36-4c56-927c-effe349286c8",
      callbackUri: "https://hive.kethalia.com/api/auth/coder/callback",
      secretName: "HIVE_CODER_OAUTH_CLIENT_SECRET",
    },
    secretNames: [
      "AUTH_SERVICE_SECRET",
      "COOKIE_SECRET",
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "HIVE_CODER_OAUTH_CLIENT_SECRET",
    ],
    databaseIdentity: {
      projectId: "prod-project",
      branchId: "prod-branch",
      database: "hive",
      role: "hive_runtime",
    },
    r2Buckets: [],
    vars: {},
    crons: [],
  };
  const snapshot = {
    ...productionTarget,
    workerTag: tag,
    createdOn,
    deploymentId: id,
    versionId: id,
    publicConfigurationDigest: "c".repeat(64),
    secretNames: configuration.secretNames,
    workersDev: false,
    versionPreviews: mode === "first-cutover",
    crons: [],
    domains: [],
    routes:
      mode === "first-cutover"
        ? []
        : [{ id: "d".repeat(32), pattern: "hive.kethalia.com/*", script: "hive" }],
    publicBindings:
      mode === "first-cutover"
        ? [{ name: "HIVE_NATIVE_MODE", type: "plain_text", text: "bootstrap" }]
        : [
            { name: "HIVE_NATIVE_MODE", type: "plain_text", text: "production" },
            { name: "HIVE_NATIVE_PRODUCTION_ACTIVE", type: "plain_text", text: "true" },
          ],
    inactive: false,
  };
  const readback = {
    schemaVersion: 1,
    scope: "production-provider-readback",
    observedAt: new Date(now).toISOString(),
    snapshot,
    settingsDigest: publicDigest(snapshot),
  };
  const enrollment = {
    schemaVersion: 1,
    mode,
    repository: "kethalia/hive",
    branch: "main",
    accountId: account,
    workerName: "hive",
    configuration,
    configurationDigest: publicDigest(configuration),
    approval: {
      action: mode === "first-cutover" ? "activate-first-production" : "deploy-reviewed-main",
      configurationDigest: publicDigest(configuration),
      approvedBy: "owner-approval-record",
      approvedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      resourceAndSecretIdentitiesVerified: true,
      schedulerHandoverVerified: true,
      rollbackRehearsalVerified: true,
      ...(mode === "first-cutover"
        ? {
            sourceRevision: source,
            baseline: { workerTag: tag, createdOn, settingsDigest: readback.settingsDigest },
          }
        : {
            firstCutoverDeploymentId: id,
            allowedParents: [
              {
                workerTag: tag,
                createdOn,
                publicConfigurationDigest: snapshot.publicConfigurationDigest,
              },
            ],
          }),
    },
  };
  const identity = {
    workersCI: "1",
    buildId: id,
    branch: "main",
    commit: source,
    head: source,
    remote: "https://github.com/kethalia/hive.git",
    clean: true,
  };
  return {
    enrollment,
    identity,
    readback,
    parse: () =>
      productionEnrollment({
        raw: JSON.stringify(enrollment),
        config,
        identity,
        root: "/source",
        now,
      }),
  };
}
function retarget(f) {
  f.enrollment.configurationDigest = publicDigest(f.enrollment.configuration);
  f.enrollment.approval.configurationDigest = f.enrollment.configurationDigest;
}
function redigest(f) {
  f.readback.settingsDigest = publicDigest(f.readback.snapshot);
}

test("exact first cutover uses approved bootstrap parent, real build output and one managed invocation", async () => {
  const f = fixture(),
    p = f.parse(),
    events = [];
  verifyProductionParent(p.enrollment, f.readback, now);
  assert.equal(p.config.name, "hive");
  assert.equal(p.config.account_id, account);
  assert.equal(
    p.config.vars.HIVE_CODER_OAUTH_CLIENT_ID,
    f.enrollment.configuration.oauthEnrollment.clientId,
  );
  assert.equal(p.config.vars.HIVE_DELIVERY_ENABLED, "false");
  assert.deepEqual(p.config.triggers.crons, []);
  assert.equal(p.config.previews, undefined);
  assert.equal(p.config.services, undefined);
  await publishManagedProduction({
    enrollment: p.enrollment,
    verifyMain: async () => {
      events.push("remote-main");
    },
    token: "existing-build-token",
    now: () => now,
    assertReady: async () => {
      events.push("actual-build-ready");
    },
    observe: async ({ token }) => {
      assert.equal(token, "existing-build-token");
      events.push("fresh-parent");
      return f.readback;
    },
    execute: () => {
      events.push("managed-deploy");
    },
  });
  assert.deepEqual(events, [
    "remote-main",
    "actual-build-ready",
    "fresh-parent",
    "remote-main",
    "managed-deploy",
  ]);
});

test("no approval, wrong source/repository/ref/build context/config or expiry cannot publish", () => {
  for (const mode of ["first-cutover", "ongoing-main"])
    for (const change of [
      (f) => {
        f.enrollment.approval = {};
      },
      (f) => {
        f.identity.workersCI = undefined;
      },
      (f) => {
        f.identity.buildId = "not-a-build";
      },
      (f) => {
        f.identity.remote = "https://github.com/other/hive.git";
      },
      (f) => {
        f.identity.commit = "b".repeat(40);
      },
      (f) => {
        f.identity.branch = "feature";
      },
      (f) => {
        f.identity.clean = false;
      },
      (f) => {
        f.enrollment.repository = "other/hive";
      },
      (f) => {
        f.enrollment.accountId = "other";
      },
      (f) => {
        f.enrollment.workerName = "hive-preview";
      },
      (f) => {
        f.enrollment.configurationDigest = "f".repeat(64);
      },
      (f) => {
        f.enrollment.approval.expiresAt = new Date(now).toISOString();
      },
      (f) => {
        f.enrollment.approval.approvedAt = new Date(now + 1).toISOString();
      },
      (f) => {
        f.enrollment.approval.rollbackRehearsalVerified = false;
      },
    ]) {
      const f = fixture(mode);
      change(f);
      assert.throws(f.parse);
    }
  const f = fixture();
  assert.throws(() =>
    productionEnrollment({ raw: undefined, config, identity: f.identity, root: "/source", now }),
  );
  f.enrollment.approval.sourceRevision = "b".repeat(40);
  assert.throws(f.parse);
  f.enrollment.approval.sourceRevision = source;
  f.enrollment.approval.expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
  assert.throws(f.parse);
});

test("first approval never grants ongoing authority; independent ongoing enrollment allows reviewed main/config transitions", () => {
  const first = fixture();
  first.enrollment.mode = "ongoing-main";
  assert.throws(first.parse);
  const f = fixture("ongoing-main");
  f.enrollment.configuration.vars = {
    HIVE_PROJECT_DISCOVERY_ENABLED: "true",
    HIVE_DELIVERY_ENABLED: "true",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICIES_JSON: "[]",
  };
  f.enrollment.configuration.crons = ["* * * * *", "*/5 * * * *"];
  retarget(f);
  const p = f.parse();
  // Explicitly allowed prior configuration differs from the newly approved config.
  verifyProductionParent(p.enrollment, f.readback, now);
  assert.equal(p.config.vars.HIVE_DELIVERY_ENABLED, "true");
  assert.deepEqual(p.config.triggers.crons, f.enrollment.configuration.crons);
  f.identity.commit = f.identity.head = "e".repeat(40);
  f.parse(); // ongoing main scope, not reuse of the old exact-source cutover grant
  f.readback.snapshot.publicConfigurationDigest = "d".repeat(64);
  redigest(f);
  assert.throws(() => verifyProductionParent(f.enrollment, f.readback, now));
  f.enrollment.approval.allowedParents.push({
    workerTag: tag,
    createdOn,
    publicConfigurationDigest: "d".repeat(64),
  });
  verifyProductionParent(f.parse().enrollment, f.readback, now);
  f.enrollment.approval.expiresAt = new Date(now + 30 * 86400_000).toISOString();
  assert.throws(f.parse);
});

test("foreign targets, Preview credentials, unknown bindings/settings and unapproved scheduling fail closed", () => {
  for (const change of [
    (c) => {
      c.origin = "https://other.kethalia.com";
    },
    (c) => {
      c.route.pattern = "*.kethalia.com/*";
    },
    (c) => {
      c.route.zone_id = "a".repeat(32);
    },
    (c) => {
      c.oauthEnrollment.clientId = config.previews.vars.HIVE_CODER_OAUTH_CLIENT_ID;
    },
    (c) => {
      c.oauthEnrollment.clientSecret = "must-not-be-accepted";
    },
    (c) => {
      c.vars.DATABASE_URL = "must-not-be-accepted";
    },
    (c) => {
      c.vars.HIVE_CODEX_ISSUER_PRIVATE_KEY = "must-not-be-accepted";
    },
    (c) => {
      c.vars.HIVE_DELIVERY_RELEASE_CLOUDFLARE_TOKEN = "must-not-be-accepted";
    },
    (c) => {
      c.vars.HIVE_DELIVERY_REPOSITORY_POLICIES_JSON = "invalid-json";
    },
    (c) => {
      c.vars.HIVE_PUBLIC_ORIGIN = "https://preview.workers.dev";
    },
    (c) => {
      c.vars.HIVE_TOKEN_ROTATION_ENABLED = "not-boolean";
    },
    (c) => {
      c.vars.HIVE_UNKNOWN_ENABLED = "true";
    },
    (c) => {
      c.secretNames.push("NEW_TOKEN");
    },
    (c) => {
      c.r2Buckets = [{ binding: "OTHER", bucket_name: "prod-bucket" }];
    },
    (c) => {
      c.services = [];
    },
    (c) => {
      c.crons = ["* * * * *", "* * * * *"];
    },
    (c) => {
      c.crons = ["* * * * * *"];
    },
  ]) {
    const f = fixture("ongoing-main");
    change(f.enrollment.configuration);
    retarget(f);
    assert.throws(f.parse);
  }
  const first = fixture();
  first.enrollment.configuration.vars.HIVE_DELIVERY_ENABLED = "true";
  retarget(first);
  assert.throws(first.parse);
  const enabled = fixture("ongoing-main");
  enabled.enrollment.configuration.vars.HIVE_CODEX_GATEWAY_ENABLED = "true";
  retarget(enabled);
  assert.throws(enabled.parse);
  enabled.enrollment.configuration.secretNames.push("HIVE_CODEX_ISSUER_PRIVATE_KEY");
  retarget(enabled);
  enabled.parse();
});

test("fresh parent/route/secret/config changes and lost acknowledgements hold without a second effect", async () => {
  for (const mode of ["first-cutover", "ongoing-main"])
    for (const change of [
      (f) => {
        f.readback.snapshot.workerTag = "e".repeat(32);
      },
      (f) => {
        f.readback.snapshot.secretNames = [];
      },
      (f) => {
        f.readback.snapshot.workersDev = true;
      },
      (f) => {
        f.readback.snapshot.domains = [{ service: "hive", hostname: "other.kethalia.com" }];
      },
      (f) => {
        f.readback.snapshot.routes = [{ script: "hive", pattern: "other.kethalia.com/*" }];
      },
      (f) => {
        f.readback.observedAt = new Date(now - 5001).toISOString();
      },
      (f) => {
        f.readback.observedAt = new Date(now + 1).toISOString();
      },
    ]) {
      const f = fixture(mode);
      change(f);
      redigest(f);
      let effects = 0;
      await assert.rejects(
        publishManagedProduction({
          enrollment: f.enrollment,
          verifyMain: async () => {},
          assertReady: async () => {},
          observe: async () => f.readback,
          token: "fixture",
          now: () => now,
          execute: () => {
            effects++;
          },
        }),
      );
      assert.equal(effects, 0);
    }
  const f = fixture();
  let effects = 0;
  await assert.rejects(
    publishManagedProduction({
      enrollment: f.parse().enrollment,
      verifyMain: async () => {},
      assertReady: async () => {},
      observe: async () => f.readback,
      now: () => now,
      execute: () => {
        effects++;
        throw Error("unknown acknowledgement");
      },
    }),
  );
  assert.equal(effects, 1);
  effects = 0;
  await assert.rejects(
    publishManagedProduction({
      enrollment: f.enrollment,
      verifyMain: async () => {},
      assertReady: async () => {
        throw Error("changed build output");
      },
      observe: async () => {
        throw Error("must not observe");
      },
      now: () => now,
      execute: () => {
        effects++;
      },
    }),
  );
  assert.equal(effects, 0);
});

test("actual production wrapper uses only installed Wrangler deploy and removes its public config on success/failure", async () => {
  const { deployManagedProduction } = await import("./deploy.mjs");
  const { existsSync, statSync } = await import("node:fs");
  for (const lostAck of [false, true]) {
    const f = fixture();
    let path,
      calls = 0;
    const execution = deployManagedProduction({
      production: f.parse(),
      verifyMain: async () => {},
      token: "existing-token",
      assertReady: async () => {},
      observe: async () => f.readback,
      now: () => now,
      execute(command, args, options) {
        calls++;
        assert.equal(command, "pnpm");
        assert.deepEqual(args.slice(0, 4), ["exec", "wrangler", "deploy", "--config"]);
        assert.equal(args.length, 6);
        assert.equal(args[5], "--strict");
        path = args[4];
        assert.equal(statSync(path).mode & 0o777, 0o600);
        const generated = JSON.parse(readFileSync(path));
        assert.equal(generated.name, "hive");
        assert.equal(generated.vars.HIVE_NATIVE_MODE, "production");
        assert.equal(generated.previews, undefined);
        assert.equal(generated.secrets.required.includes("HIVE_CODER_OAUTH_CLIENT_SECRET"), true);
        assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, account);
        if (lostAck) throw Error("unknown acknowledgement");
      },
    });
    if (lostAck) await assert.rejects(execution);
    else await execution;
    assert.equal(calls, 1);
    assert.equal(existsSync(path), false);
  }
});

test("ongoing enrollment explicitly enables existing roadmap capabilities while bootstrap stays off", () => {
  const flags = [
    "HIVE_NATIVE_HEALTH_ENABLED",
    "HIVE_CODEX_ACCOUNTS_ENABLED",
    "HIVE_CLAUDE_ACCOUNTS_ENABLED",
    "HIVE_AGENT_TOOLS_ENABLED",
    "HIVE_WORKSPACE_READ_ENABLED",
    "HIVE_CODEX_VOICE_ENABLED",
    "HIVE_GENERIC_TERMINAL_ENABLED",
    "HIVE_CODEX_TERMINAL_ENABLED",
    "HIVE_TERMINAL_PASTE_ENABLED",
    "HIVE_DELIVERY_DISPATCH_ENABLED",
    "HIVE_TOKEN_ROTATION_ENABLED",
  ];
  const bootstrap = fixture().parse();
  for (const name of flags) assert.equal(bootstrap.config.vars[name], "false");
  const f = fixture("ongoing-main");
  for (const name of flags) f.enrollment.configuration.vars[name] = "true";
  Object.assign(f.enrollment.configuration.vars, {
    HIVE_CODEX_GATEWAY_ENABLED: "true",
    HIVE_WORKSPACE_ISSUER_MODE: "shared-host",
    HIVE_AGENT_TOOLS_HIVE_ORIGIN: "https://hive.kethalia.com",
    HIVE_AGENT_TOOLS_TRANSPORT: "workspace-app",
    HIVE_AGENT_TOOLS_ISSUER_KEY_ID: "reviewed-shared-host",
    HIVE_AGENT_TOOLS_PINS_JSON: "[]",
    HIVE_WORKSPACE_READ_HIVE_ORIGIN: "https://hive.kethalia.com",
    HIVE_WORKSPACE_READ_ISSUER_KEY_ID: "reviewed-shared-host",
    HIVE_WORKSPACE_READ_PROFILES_JSON: "[]",
    HIVE_VOICE_ISSUER_KEY_ID: "reviewed-shared-host",
    HIVE_VOICE_TRANSPORT: "workspace-app",
    HIVE_VOICE_TEMPLATE_PINS_JSON: "[]",
    HIVE_TERMINAL_WS_URL: "/",
    HIVE_VOICE_ALLOWED_ORIGINS: "https://hive.kethalia.com",
  });
  f.enrollment.configuration.secretNames.push("HIVE_CODEX_ISSUER_PRIVATE_KEY");
  retarget(f);
  const p = f.parse();
  for (const name of flags) assert.equal(p.config.vars[name], "true");
  assert.equal(p.config.vars.HIVE_WORKSPACE_ISSUER_MODE, "shared-host");
  assert.deepEqual(p.config.secrets.required, [...f.enrollment.configuration.secretNames].sort());
  for (const name of flags) {
    const invalid = fixture("ongoing-main");
    invalid.enrollment.configuration.vars[name] = "not-a-boolean";
    retarget(invalid);
    assert.throws(invalid.parse);
  }
  f.enrollment.configuration.vars.HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY = "not-an-input";
  retarget(f);
  assert.throws(f.parse);
});

test("bounded fixed remote-main read rejects old queued commits, malformed refs and transport failure", () => {
  const expectedArgs = [
    "ls-remote",
    "--exit-code",
    "https://github.com/kethalia/hive.git",
    "refs/heads/main",
  ];
  verifyRemoteMain(source, (command, args, options) => {
    assert.equal(command, "git");
    assert.deepEqual(args, expectedArgs);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 4096);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    return `${source}\trefs/heads/main\n`;
  });
  for (const output of [
    `${"e".repeat(40)}\trefs/heads/main\n`,
    `${source}\trefs/heads/other\n`,
    `${source}\trefs/heads/main\nextra\n`,
    "",
  ])
    assert.throws(() => verifyRemoteMain(source, () => output));
  assert.throws(() =>
    verifyRemoteMain(source, () => {
      throw Error("bounded transport failed");
    }),
  );
});

test("remote main advancing during slow observation produces zero deployment effects", async () => {
  const f = fixture("ongoing-main"),
    order = [];
  let effects = 0,
    remote = source;
  await assert.rejects(
    publishManagedProduction({
      enrollment: f.parse().enrollment,
      verifyMain: async () => {
        order.push("remote-main");
        verifyRemoteMain(source, () => `${remote}\trefs/heads/main\n`);
      },
      assertReady: async () => {
        order.push("build-ready");
      },
      observe: async () => {
        order.push("observed-parent");
        remote = "f".repeat(40);
        return f.readback;
      },
      now: () => now,
      execute: () => {
        effects++;
      },
    }),
    /no longer the current remote main/,
  );
  assert.equal(effects, 0);
  assert.deepEqual(order, ["remote-main", "build-ready", "observed-parent", "remote-main"]);
});

test("existing project wake requires its named remote secret and template logs require explicit enrollment", () => {
  const base = fixture().parse();
  assert.equal(base.config.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED, "false");
  const f = fixture("ongoing-main");
  f.enrollment.configuration.vars.HIVE_PROJECT_TASKS_ENABLED = "true";
  retarget(f);
  assert.throws(f.parse);
  f.enrollment.configuration.secretNames.push("HIVE_PROJECT_TASK_RECONCILE_SECRET");
  retarget(f);
  const enabled = f.parse();
  assert.ok(enabled.config.secrets.required.includes("HIVE_PROJECT_TASK_RECONCILE_SECRET"));
  assert.equal(enabled.config.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED, "false");
  f.enrollment.configuration.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED = "true";
  retarget(f);
  assert.equal(f.parse().config.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED, "true");
  f.enrollment.configuration.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED = "false";
  retarget(f);
  assert.equal(f.parse().config.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED, "false");
  f.enrollment.configuration.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED = "invalid";
  retarget(f);
  assert.throws(f.parse);
  delete f.enrollment.configuration.vars.HIVE_TEMPLATE_LOG_VIEW_ENABLED;
  f.enrollment.configuration.secretNames = f.enrollment.configuration.secretNames.map((name) =>
    name === "HIVE_PROJECT_TASK_RECONCILE_SECRET"
      ? "HIVE_PROJECT_TASK_RECONCILE_SECRET_OTHER"
      : name,
  );
  retarget(f);
  assert.throws(f.parse);
  f.enrollment.configuration.secretNames.push("HIVE_PROJECT_TASK_RECONCILE_SECRET");
  retarget(f);
  assert.throws(f.parse); // extra/wrong secret name still rejected
});

test("D10 ongoing enrollment requires its existing signing-key name without accepting key or token values", () => {
  const f = fixture("ongoing-main");
  Object.assign(f.enrollment.configuration.vars, {
    HIVE_DELIVERY_DATABASE_ENABLED: "true",
    HIVE_DELIVERY_DATABASE_CATALOGS_JSON: "[]",
    HIVE_DELIVERY_RELEASE_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: "{}",
    HIVE_DELIVERY_RELEASE_SCHEDULER_ENABLED: "true",
    HIVE_NATIVE_HEALTH_ENABLED: "true",
  });
  retarget(f);
  assert.throws(f.parse);
  f.enrollment.configuration.secretNames.push("HIVE_DELIVERY_DATABASE_SIGNING_KEY");
  retarget(f);
  const p = f.parse();
  assert.ok(p.config.secrets.required.includes("HIVE_DELIVERY_DATABASE_SIGNING_KEY"));
  assert.equal(p.config.vars.HIVE_DELIVERY_DATABASE_CATALOGS_JSON, "[]");
  f.enrollment.configuration.secretNames = f.enrollment.configuration.secretNames.map((name) =>
    name === "HIVE_DELIVERY_DATABASE_SIGNING_KEY"
      ? "HIVE_DELIVERY_DATABASE_SIGNING_KEY_OTHER"
      : name,
  );
  retarget(f);
  assert.throws(f.parse);
  f.enrollment.configuration.secretNames = f.enrollment.configuration.secretNames.filter(
    (name) => name !== "HIVE_DELIVERY_DATABASE_SIGNING_KEY_OTHER",
  );
  f.enrollment.configuration.secretNames.push("HIVE_DELIVERY_DATABASE_SIGNING_KEY");
  for (const name of [
    "HIVE_DELIVERY_DATABASE_SIGNING_KEY",
    "HIVE_DELIVERY_DATABASE_GITHUB_TOKEN",
    "HIVE_DATABASE_URL",
    "DATABASE_URL",
  ]) {
    f.enrollment.configuration.vars[name] = "not-a-public-input";
    retarget(f);
    assert.throws(f.parse);
    delete f.enrollment.configuration.vars[name];
  }
});
