import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";
import { decodeHostArchive } from "../../../scripts/host-archive-codec.mjs";
import {
  GUARDIAN_CONTROLLER_POLICY,
  GUARDIAN_CONTROLLER_POLICY_DIGEST,
} from "../../../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";
import { PILOT_EVIDENCE_BUCKET } from "../app/delivery-pilot-bucket.mjs";
import {
  account,
  oauthPreviewBranch,
  plan,
  previewTarget,
  resolvePreviewOrigin,
  validateConfig,
} from "./deploy.mjs";

const config = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url)));
const clone = () => structuredClone(config);
test("isolated bootstrap and preview config have no production data or service bindings", () => {
  validateConfig(config);
  for (const change of [
    (c) => (c.account_id = "other"),
    (c) => (c.vars.HIVE_NATIVE_MODE = "production"),
    (c) => (c.services = [{ binding: "AUTH_SERVICE", service: "production" }]),
    (c) => (c.previews.services = [{ binding: "AUTH_SERVICE", service: "production" }]),
    (c) => (c.previews.r2_buckets = [{ binding: "DATA", bucket_name: "production" }]),
    (c) => (c.previews.vars.DATABASE_URL = "postgres://bad"),
    (c) => (c.previews.placement = { region: "aws:eu-central-1" }),
    (c) => delete c.previews.placement,
    (c) => (c.triggers.crons = ["* * * * *"]),
  ]) {
    const c = clone();
    change(c);
    assert.throws(() => validateConfig(c));
  }
  assert.equal(config.account_id, account);
  assert.deepEqual(config.previews.placement, { region: "aws:us-east-1" });
  assert.equal(config.placement, undefined);
  assert.equal(config.previews.vars.HIVE_PREVIEW_ACCESS_REQUIRED, "false");
  assert.deepEqual(config.previews.secrets.required, [
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "COOKIE_SECRET",
    "AUTH_SERVICE_SECRET",
    "HIVE_CODER_OAUTH_CLIENT_SECRET",
  ]);
});
test("reviewed public host and guarded-manager settings can opt in through the managed Preview", () => {
  const c = clone();
  Object.assign(c.previews.vars, {
    HIVE_PROJECT_DISCOVERY_ENABLED: "true",
    HIVE_PROJECT_TASKS_ENABLED: "true",
    HIVE_DELIVERY_ENABLED: "true",
    HIVE_CODEX_GATEWAY_ENABLED: "true",
    HIVE_PUBLIC_ORIGIN: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
    HIVE_CODEX_HIVE_ORIGIN: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
    HIVE_CODEX_ISSUER_KEY_ID: "reviewed-existing-host",
    HIVE_CODEX_ISSUER_PUBLIC_KEY: "public host key; validated by the existing runtime",
    HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
    HIVE_CODEX_MANAGER_EFFORT: "high",
    HIVE_GUARDIAN_ENABLED: "true",
    HIVE_GUARDIAN_APPROVED_PACKAGES_JSON: "[]",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    HIVE_DELIVERY_EXECUTION_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICIES_JSON: "[]",
    HIVE_DELIVERY_ACCEPTANCE_ENABLED: "true",
    HIVE_DELIVERY_ACCEPTANCE_PRODUCER: "{}",
    HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED: "true",
    HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED: "true",
  });
  c.previews.r2_buckets = [
    { binding: "HIVE_DELIVERY_EVIDENCE", bucket_name: PILOT_EVIDENCE_BUCKET.name },
  ];
  assert.doesNotThrow(() => validateConfig(c));
  assert.equal(
    plan({ branch: oauthPreviewBranch, target: "preview", config: c }).target,
    "preview",
  );
  assert.throws(() => plan({ branch: "main", target: "production", config: c }));
  assert.deepEqual(c.vars, { HIVE_NATIVE_MODE: "bootstrap" });
  assert.deepEqual(c.triggers, { crons: [] });
  assert.equal(c.previews.vars.HIVE_DELIVERY_DISPATCH_ENABLED, "false");
  assert.equal(c.previews.vars.HIVE_TOKEN_ROTATION_ENABLED, "false");
});
test("Preview enrollment rejects credentials, unknown settings, production authority and resource drift", () => {
  for (const change of [
    (c) => (c.previews.vars.HIVE_CODEX_ISSUER_PRIVATE_KEY = "private"),
    (c) => (c.previews.vars.HIVE_DELIVERY_RELEASE_GITHUB_TOKEN = "credential"),
    (c) => (c.previews.vars.HIVE_UNKNOWN_SETTING = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_MANAGER_ENABLED = "yes"),
    (c) => (c.previews.vars.HIVE_DELIVERY_MANAGER_ENABLED = true),
    (c) => (c.previews.vars.HIVE_PUBLIC_ORIGIN = "https://other.invalid"),
    (c) => (c.previews.vars.HIVE_CODEX_HIVE_ORIGIN = "https://other.invalid"),
    (c) => (c.previews.vars.HIVE_NATIVE_MODE = "production"),
    (c) => (c.previews.vars.HIVE_DISABLE_BACKGROUND_WORKERS = "false"),
    (c) => (c.previews.vars.HIVE_DELIVERY_DISPATCH_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_TOKEN_ROTATION_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_EPICS_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_RELEASE_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_DATABASE_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_NATIVE_PRODUCTION_ACTIVE = "true"),
    (c) => (c.previews.vars.HIVE_GUARDIAN_APPROVED_PACKAGES_JSON = "x".repeat(262145)),
    (c) => delete c.previews.vars.HIVE_PROJECT_TASKS_ENABLED,
    (c) =>
      (c.previews.r2_buckets = [{ binding: "HIVE_DELIVERY_EVIDENCE", bucket_name: "production" }]),
    (c) =>
      (c.previews.r2_buckets = [{ binding: "OTHER", bucket_name: PILOT_EVIDENCE_BUCKET.name }]),
    (c) =>
      (c.previews.r2_buckets = [
        {
          binding: "HIVE_DELIVERY_EVIDENCE",
          bucket_name: PILOT_EVIDENCE_BUCKET.name,
          remote: true,
        },
      ]),
    (c) => (c.previews.triggers = { crons: ["* * * * *"] }),
    (c) => (c.previews.routes = ["production.example/*"]),
  ]) {
    const c = clone();
    change(c);
    assert.throws(() => validateConfig(c));
  }
});
test("branch name preserves the provider-managed Preview identity", () => {
  const a = previewTarget("codex/example-branch");
  assert.deepEqual(a, previewTarget("codex/example-branch"));
  assert.notEqual(a.name, previewTarget("codex/example_branch").name);
  assert.equal(a.name, "codex/example-branch");
  assert.equal(a.origin, undefined);
  for (const bad of ["", "main", "MAIN", "-flag", "a b", "a\nother", "a".repeat(201)])
    assert.throws(() => previewTarget(bad));
});
test("provider metadata pins the exact branch and valid slug without exposing token", async () => {
  const token = "synthetic-private-token";
  const branch = "codex/delivery-system-design";
  const fetcher = async (url, options) => {
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/hive/previews/codex%2Fdelivery-system-design`,
    );
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json({
      success: true,
      result: { name: branch, slug: "codex-delivery-system-design" },
    });
  };
  assert.deepEqual(await resolvePreviewOrigin(branch, token, fetcher), {
    name: branch,
    origin: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
  });
  for (const response of [
    Response.json({ success: true, result: { name: "other", slug: "safe" } }),
    Response.json({ success: true, result: { name: branch, slug: "bad.example" } }),
    Response.json({ success: true, result: { name: branch, slug: "a".repeat(59) } }),
    Response.json({ success: false, result: { name: branch, slug: "safe" } }),
    new Response("x".repeat(65537)),
    new Response("unavailable", { status: 404 }),
  ])
    await assert.rejects(
      resolvePreviewOrigin(branch, token, async () => response),
      (error) => error.message === "Preview metadata unavailable" && !error.message.includes(token),
    );
  await assert.rejects(resolvePreviewOrigin(branch, "", fetcher));
  await assert.rejects(
    resolvePreviewOrigin(branch, token, async () => {
      throw Error(token);
    }),
    (error) => !error.message.includes(token),
  );
});
test("production defaults to check/dry-run only, while branch preview cannot target main", () => {
  assert.throws(() => plan({ branch: "main", target: "production", config }));
  assert.equal(
    plan({ branch: "main", target: "production", check: true, config }).target,
    "production",
  );
  assert.throws(() => plan({ branch: "feature", target: "production", check: true, config }));
  assert.throws(() => plan({ branch: "main", target: "preview", check: true, config }));
  assert.throws(() =>
    plan({ branch: "feature", target: "preview", check: true, dryRun: true, config }),
  );
  assert.equal(
    plan({ branch: oauthPreviewBranch, target: "preview", check: true, config }).target,
    "preview",
  );
  assert.throws(
    () => plan({ branch: "feature", target: "preview", check: true, config }),
    /Enroll an exact Coder OAuth callback/,
  );
});

test("CLI checks do not deploy and reject a mismatched account or production action", () => {
  const script = new URL("./deploy.mjs", import.meta.url).pathname;
  const run = (branch, args, extra = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, WORKERS_CI_BRANCH: branch, CLOUDFLARE_ACCOUNT_ID: account, ...extra },
    });
  const preview = run(oauthPreviewBranch, ["preview", "--check"]);
  assert.equal(preview.status, 0);
  assert.equal(JSON.parse(preview.stdout).name, oauthPreviewBranch);
  assert.equal(JSON.parse(preview.stdout).origin, undefined);
  const isolated = run(oauthPreviewBranch, ["preview", "--check"], {
    HIVE_NATIVE_PRODUCTION_ENROLLMENT_JSON: "malformed unused production enrollment",
  });
  assert.equal(isolated.status, 0);
  assert.equal(isolated.stdout, preview.stdout);
  assert.notEqual(
    run("codex/example", ["preview", "--check"], { CLOUDFLARE_ACCOUNT_ID: "wrong" }).status,
    0,
  );
  assert.notEqual(run("main", ["production"]).status, 0);
  assert.notEqual(run("main", ["preview", "--check"]).status, 0);
  assert.notEqual(run("codex/unenrolled", ["preview", "--check"]).status, 0);
});

test("managed Codex accounts stay absent/off by default and require explicit public enrollment", () => {
  assert.equal(config.vars.HIVE_CODEX_ACCOUNTS_ENABLED, undefined);
  const c = clone();
  delete c.previews.vars.HIVE_CODEX_ACCOUNTS_ENABLED;
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CODEX_ACCOUNTS_ENABLED = "true";
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CODEX_ACCOUNTS_ENABLED = "arbitrary";
  assert.throws(() => validateConfig(c));
});

test("workspace Claude accounts require explicit public enrollment without new secrets", () => {
  assert.equal(config.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED, undefined);
  const c = clone();
  delete c.previews.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED;
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED = "true";
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED = "arbitrary";
  assert.throws(() => validateConfig(c));
});

test("account maintenance is default-off and independently enrolled as a public boolean", () => {
  assert.notEqual(config.previews.vars.HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED, "true");
  const c = clone();
  c.previews.vars.HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED = "true";
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED = "arbitrary";
  assert.throws(() => validateConfig(c));
});

// Compare the configuration consumed by the real managed Builds command with
// checked-in runtime bytes, rather than accepting a manually patched Preview.
async function packagedFiles(bytes) {
  const files = new Map(),
    extract = tar.extract();
  const done = new Promise((resolve, reject) => {
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.on("entry", (header, stream, next) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => {
        try {
          if (header.type === "file") {
            assert.equal(files.has(header.name), false);
            files.set(header.name, Buffer.concat(chunks));
          }
          next();
        } catch (error) {
          reject(error);
          extract.destroy(error);
        }
      });
    });
  });
  extract.end(bytes);
  await done;
  return files;
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asset = (name) =>
  readFileSync(new URL(`../../../templates/ai-dev-k8s/assets/${name}`, import.meta.url));

test("managed Preview keeps the packaged host and its exact recovery predecessor enrolled", async () => {
  const raw = decodeHostArchive(asset("codex-host.tar.xz"));
  assert.equal(sha256(raw), asset("codex-host.tar.sha256").toString().trim());
  const files = await packagedFiles(raw),
    manifestBytes = files.get("package-manifest.json"),
    manifest = JSON.parse(manifestBytes);
  for (const [name, digest] of Object.entries(manifest.files))
    assert.equal(sha256(files.get(name)), digest);
  const packages = JSON.parse(config.previews.vars.HIVE_GUARDIAN_APPROVED_PACKAGES_JSON);
  assert.equal(new Set(packages.map((p) => p.packageManifestSha256)).size, packages.length);
  const expected = {
    guardianElfSha256: manifest.guardian.elfSha256,
    nodeSha256: "904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52",
    protocol: "guardian-v1",
    policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
    metadataPolicyDigest: GUARDIAN_CONTROLLER_POLICY.metadataPolicyDigest,
  };
  assert.equal(expected.guardianElfSha256, manifest.files["codex-native-guardian"]);
  assert.deepEqual(
    packages.find((p) => p.packageManifestSha256 === sha256(manifestBytes)),
    { packageManifestSha256: sha256(manifestBytes), ...expected },
  );
  const retained = {
    guardianElfSha256: "ad7facb0f9605c70694f366978408c8b4d5e7a886cb93bdba580835a1255c0fd",
    nodeSha256: "904a6d3484241d466989f9df9ba3aab822b1496191bdb28230eb491a55c32a52",
    protocol: "guardian-v1",
    policyDigest: "0c258221d52fe302e5a8017b6029e938379a71337bb8024516bff9f9275dae50",
    metadataPolicyDigest: "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
  };
  for (const digest of [
    "7eb52d53f4c6664743d4da182ff35dbe042bde53017647d18209b4eb885180c7",
    "36895da38fa1ff06c43e60cdfc37c67d084cafb2649b809c0a14726455b544aa",
    "80fa379a2dea736517ac5f29113e6d69a3758de8cea6b6ac87abc2cd21addd46",
    "5ac58e3b8a6b14c25ec8e376bc7a6f88a92094ae00e5fe88f6e538157cb7d3a4",
    "2210b850e6d73e33cd3380f871b73956c00de98a8266de3c1c90ed209b048f77",
  ]) {
    assert.deepEqual(
      packages.find((p) => p.packageManifestSha256 === digest),
      { packageManifestSha256: digest, ...retained },
      "Builds must retain the reviewed package tuple",
    );
  }
});

test("managed Preview account pins match the packaged software bridge and helper", async () => {
  const raw = gunzipSync(asset("agent-bridge.tar.gz")),
    files = await packagedFiles(raw),
    manifestBytes = files.get("manifest.json"),
    manifest = JSON.parse(manifestBytes);
  assert.equal(sha256(raw), asset("agent-bridge.tar.sha256").toString().trim());
  for (const [name, digest] of Object.entries(manifest.files))
    assert.equal(sha256(files.get(name)), digest);
  const pins = JSON.parse(config.previews.vars.HIVE_AGENT_TOOLS_PINS_JSON).filter(
    (p) => p.templateId === "06ab5cf1-fc5a-4f98-ac96-94a6eaf5ef42" && p.profile === "software",
  );
  assert.equal(pins.length, 1);
  assert.equal(pins[0].manifestSha256, sha256(manifestBytes));
  assert.equal(pins[0].manifestSha256, asset("agent-bridge.manifest.sha256").toString().trim());
  assert.equal(pins[0].helperSha256, sha256(files.get("agent-tools.py")));
  assert.equal(pins[0].helperSha256, asset("agent-bridge.helper.sha256").toString().trim());
});
