// Offline bootstrap preparation only. This module never calls a provider or runs
// a publication command; normal deploy.mjs production remains fail-closed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBuildReady, READY_FILE } from "../app/build-integrity.mjs";
import { account, validateConfig } from "./deploy.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value, length = 64) => assert.match(value, new RegExp(`^[a-f0-9]{${length}}$`));
const nonempty = (value) =>
  assert.ok(
    typeof value === "string" && value.length > 0 && value.length < 256 && !/[\r\n]/.test(value),
  );
const exact = (object, keys) => assert.deepEqual(Object.keys(object).sort(), [...keys].sort());
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const required = ["AUTH_SERVICE_SECRET", "COOKIE_SECRET", "DATABASE_URL", "ENCRYPTION_KEY"];

function baseline(value) {
  exact(value, [
    "accountId",
    "workerName",
    "workerTag",
    "createdOn",
    "deploymentId",
    "versionId",
    "settingsDigest",
    "inactive",
  ]);
  assert.equal(value.accountId, account);
  assert.equal(value.workerName, "hive");
  for (const key of ["workerTag", "deploymentId", "versionId"]) nonempty(value[key]);
  assert.ok(Number.isFinite(Date.parse(value.createdOn)));
  hex(value.settingsDigest);
  assert.equal(value.inactive, true);
}

export function prepareProduction({
  manifest,
  config,
  readyBytes,
  proofBytes,
  revision,
  branch,
  clean,
  root,
}) {
  validateConfig(config);
  exact(manifest, [
    "schemaVersion",
    "sourceRevision",
    "origin",
    "route",
    "secretNames",
    "databaseIdentity",
    "r2Buckets",
    "baseline",
    "evidenceDigests",
  ]);
  assert.equal(manifest.schemaVersion, 1);
  hex(revision, 40);
  assert.equal(branch, "main", "Prepare the merged main artifact, not a PR artifact");
  assert.equal(clean, true, "Production preparation requires a clean source checkout");
  assert.equal(manifest.sourceRevision, revision);
  const origin = new URL(manifest.origin);
  assert.equal(origin.protocol, "https:");
  assert.equal(origin.port, "");
  assert.equal(isIP(origin.hostname), 0);
  assert.ok(origin.hostname.includes("."));
  assert.equal(origin.origin, manifest.origin);
  assert.ok(!origin.hostname.endsWith(".workers.dev") && origin.hostname !== "localhost");
  exact(manifest.route, ["pattern", "zone_id"]);
  assert.equal(manifest.route.pattern, `${origin.hostname}/*`);
  hex(manifest.route.zone_id, 32);
  baseline(manifest.baseline);
  assert.deepEqual([...manifest.secretNames].sort(), required);
  // Production resources must be recorded independently of synthetic Preview.
  exact(manifest.databaseIdentity, ["projectId", "branchId", "database", "role"]);
  for (const value of Object.values(manifest.databaseIdentity))
    assert.match(value, /^[A-Za-z0-9_.-]{1,128}$/);
  assert.ok(!/preview|synthetic/i.test(Object.values(manifest.databaseIdentity).join(" ")));
  assert.ok(Array.isArray(manifest.r2Buckets) && manifest.r2Buckets.length <= 1);
  for (const bucket of manifest.r2Buckets) {
    exact(bucket, ["binding", "bucket_name"]);
    assert.equal(bucket.binding, "HIVE_DELIVERY_EVIDENCE");
    assert.match(bucket.bucket_name, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
    assert.ok(!/preview|synthetic/i.test(bucket.bucket_name));
  }
  exact(manifest.evidenceDigests, ["buildReady", "nativeProof"]);
  assert.equal(digest(readyBytes), manifest.evidenceDigests.buildReady);
  assert.equal(digest(proofBytes), manifest.evidenceDigests.nativeProof);
  const proof = JSON.parse(proofBytes);
  assert.equal(proof.testedRevision, revision);
  for (const key of [
    "testedSourceCommitted",
    "sourceStable",
    "nativeEntrypoint",
    "inlineAuthAndRequestLifetimeVerified",
  ])
    assert.equal(proof[key], true);
  assert.equal(proof.result?.ok, true);
  assert.equal(proof.httpStatus, 200);
  assert.equal(proof.appBuildReadySHA256, manifest.evidenceDigests.buildReady);
  const production = {
    name: "hive",
    account_id: account,
    main: join(root, "deploy/cloudflare/native/worker.ts"),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    assets: { ...config.assets, directory: join(root, ".open-next/assets") },
    limits: config.limits,
    routes: [manifest.route],
    triggers: { crons: [] },
    secrets: { required },
    vars: {
      ...config.previews.vars,
      HIVE_NATIVE_MODE: "production",
      HIVE_NATIVE_PREVIEW_ENABLED: "false",
      HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
      HIVE_PUBLIC_ORIGIN: manifest.origin,
    },
    ...(manifest.r2Buckets.length ? { r2_buckets: manifest.r2Buckets } : {}),
  };
  // First bootstrap serves the application only. Native jobs/release/rotation
  // require their own reviewed policy, scheduler handover and account proofs.
  const configBytes = json(production);
  const record = {
    schemaVersion: 1,
    scope: "offline-first-production-preparation",
    sourceRevision: revision,
    manifestDigest: digest(json(manifest)),
    configDigest: digest(configBytes),
    evidenceDigests: manifest.evidenceDigests,
    baseline: manifest.baseline,
    production,
    activationAuthorized: false,
    providerBaselineVerified: false,
  };
  return { record, configBytes };
}

// Produces arguments only; caller must independently fetch/normalize the fresh
// provider baseline, verify resource/secret identities and execute after approval.
// An operator JSON record is not a provider attestation or a credential.
export function publicationRecipe({
  record,
  configBytes,
  authorization,
  freshBaseline,
  configPath,
  secretsPath,
  now = Date.now(),
}) {
  assert.equal(record.scope, "offline-first-production-preparation");
  assert.equal(digest(configBytes), record.configDigest);
  exact(authorization, [
    "schemaVersion",
    "action",
    "preparationDigest",
    "approvedBy",
    "approvedAt",
    "expiresAt",
    "resourceAndSecretIdentitiesVerified",
    "schedulerHandoverVerified",
    "rollbackRehearsalVerified",
  ]);
  assert.equal(authorization.schemaVersion, 1);
  assert.equal(authorization.action, "activate-first-production");
  assert.equal(authorization.preparationDigest, digest(json(record)));
  nonempty(authorization.approvedBy);
  const start = Date.parse(authorization.approvedAt),
    end = Date.parse(authorization.expiresAt);
  assert.ok(start <= now && now < end && end - start <= 30 * 60 * 1000);
  for (const key of [
    "resourceAndSecretIdentitiesVerified",
    "schedulerHandoverVerified",
    "rollbackRehearsalVerified",
  ])
    assert.equal(authorization[key], true);
  exact(freshBaseline, ["observedAt", "baseline"]);
  const observed = Date.parse(freshBaseline.observedAt);
  assert.ok(observed <= now && now - observed <= 5 * 60 * 1000);
  baseline(freshBaseline.baseline);
  assert.deepEqual(
    freshBaseline.baseline,
    record.baseline,
    "Parent Worker changed; prepare and approve again",
  );
  for (const path of [configPath, secretsPath])
    assert.ok(typeof path === "string" && path.startsWith("/") && !/[\r\n]/.test(path));
  return [
    "pnpm",
    "exec",
    "wrangler",
    "deploy",
    "--config",
    configPath,
    "--strict",
    "--secrets-file",
    secretsPath,
  ];
}

async function run() {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const git = (...flags) => execFileSync("git", flags, { cwd: root, encoding: "utf8" }).trim();
  if (args[0] === "--recipe") {
    assert.equal(args.length, 5);
    const [, directory, authorizationPath, freshBaselinePath, secretsPath] = args;
    await assertBuildReady(root);
    const record = JSON.parse(readFileSync(join(directory, "preparation.json")));
    assert.equal(git("branch", "--show-current"), "main");
    assert.equal(git("rev-parse", "HEAD"), record.sourceRevision);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(digest(readFileSync(join(root, READY_FILE))), record.evidenceDigests.buildReady);
    console.log(
      JSON.stringify(
        publicationRecipe({
          record,
          configBytes: readFileSync(join(directory, "wrangler.production.json"), "utf8"),
          authorization: JSON.parse(readFileSync(authorizationPath)),
          freshBaseline: JSON.parse(readFileSync(freshBaselinePath)),
          configPath: resolve(directory, "wrangler.production.json"),
          secretsPath,
        }),
      ),
    );
    return;
  }
  const [manifestPath, proofPath, output, ...extra] = args;
  assert.ok(manifestPath && proofPath && output && extra.length === 0);
  // Reuse the application build's existing source/output integrity checks.
  await assertBuildReady(root);
  const result = prepareProduction({
    manifest: JSON.parse(readFileSync(manifestPath)),
    config: JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url))),
    readyBytes: readFileSync(join(root, READY_FILE)),
    proofBytes: readFileSync(proofPath),
    revision: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    clean: git("status", "--porcelain") === "",
    root,
  });
  mkdirSync(output, { recursive: false, mode: 0o700 });
  writeFileSync(join(output, "wrangler.production.json"), result.configBytes, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(join(output, "preparation.json"), json(result.record), { flag: "wx", mode: 0o600 });
  console.log("Offline production preparation saved; activation remains unauthorized.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(() => {
    console.error("Production preparation rejected.");
    process.exitCode = 1;
  });
}
