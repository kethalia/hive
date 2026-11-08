// Owner-managed public Builds enrollment. This is configuration authority, not
// proof of provider approval, secret identity, application health or atomic CAS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  account,
  exact,
  managedProductionConfiguration,
  productionTarget,
  publicDigest,
  validateManagedProductionConfiguration,
} from "./production-configuration.mjs";
import { collectProductionReadback } from "./production-readback.mjs";

const hash = (value) => assert.match(value, /^[a-f0-9]{64}$/);
const uuid = (value) => assert.match(value, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
function time(value) {
  assert.equal(typeof value, "string");
  const result = Date.parse(value);
  assert.ok(Number.isFinite(result));
  return result;
}
function parent(value, digestName) {
  exact(value, ["workerTag", "createdOn", digestName]);
  assert.match(value.workerTag, /^[a-f0-9]{32}$/);
  time(value.createdOn);
  hash(value[digestName]);
}

export function productionEnrollment({ raw, config, identity, root, now = Date.now() }) {
  assert.ok(
    typeof raw === "string" && raw.length > 0 && Buffer.byteLength(raw) <= 524288,
    "Production deployment is disabled pending cutover enrollment",
  );
  const enrollment = JSON.parse(raw);
  exact(enrollment, [
    "schemaVersion",
    "mode",
    "repository",
    "branch",
    "accountId",
    "workerName",
    "configuration",
    "configurationDigest",
    "approval",
  ]);
  assert.equal(enrollment.schemaVersion, 1);
  assert.ok(["first-cutover", "ongoing-main"].includes(enrollment.mode));
  assert.equal(enrollment.repository, "kethalia/hive");
  assert.equal(enrollment.branch, "main");
  assert.equal(enrollment.accountId, account);
  assert.equal(enrollment.workerName, "hive");
  assert.equal(identity.workersCI, "1");
  uuid(identity.buildId);
  assert.equal(identity.branch, "main");
  assert.match(identity.commit, /^[a-f0-9]{40}$/);
  assert.equal(identity.head, identity.commit);
  assert.ok(
    [
      "https://github.com/kethalia/hive.git",
      "https://github.com/kethalia/hive",
      "git@github.com:kethalia/hive.git",
    ].includes(identity.remote),
  );
  assert.equal(identity.clean, true);
  validateManagedProductionConfiguration(enrollment.configuration, enrollment.mode, config);
  assert.equal(enrollment.configurationDigest, publicDigest(enrollment.configuration));
  const a = enrollment.approval;
  const common = [
    "action",
    "configurationDigest",
    "approvedBy",
    "approvedAt",
    "expiresAt",
    "resourceAndSecretIdentitiesVerified",
    "schedulerHandoverVerified",
    "rollbackRehearsalVerified",
  ];
  exact(a, [
    ...common,
    ...(enrollment.mode === "first-cutover"
      ? ["sourceRevision", "baseline"]
      : ["firstCutoverDeploymentId", "allowedParents"]),
  ]);
  assert.equal(a.configurationDigest, enrollment.configurationDigest);
  assert.equal(typeof a.approvedBy, "string");
  assert.ok(a.approvedBy.length > 0 && a.approvedBy.length <= 256 && !/[\r\n]/.test(a.approvedBy));
  const start = time(a.approvedAt),
    end = time(a.expiresAt);
  assert.ok(start <= now && now < end && end > start);
  for (const name of [
    "resourceAndSecretIdentitiesVerified",
    "schedulerHandoverVerified",
    "rollbackRehearsalVerified",
  ])
    assert.equal(a[name], true);
  if (enrollment.mode === "first-cutover") {
    assert.equal(a.action, "activate-first-production");
    assert.equal(a.sourceRevision, identity.commit);
    assert.ok(end - start <= 30 * 60 * 1000);
    parent(a.baseline, "settingsDigest");
  } else {
    assert.equal(a.action, "deploy-reviewed-main");
    assert.ok(end - start <= 30 * 24 * 60 * 60 * 1000);
    uuid(a.firstCutoverDeploymentId);
    assert.ok(
      Array.isArray(a.allowedParents) &&
        a.allowedParents.length > 0 &&
        a.allowedParents.length <= 4,
    );
    for (const item of a.allowedParents) parent(item, "publicConfigurationDigest");
    assert.equal(new Set(a.allowedParents.map(publicDigest)).size, a.allowedParents.length);
  }
  return {
    enrollment,
    sourceRevision: identity.commit,
    config: managedProductionConfiguration(enrollment.configuration, config, root),
  };
}

export function verifyProductionParent(enrollment, readback, now = Date.now()) {
  assert.equal(readback.schemaVersion, 1);
  assert.equal(readback.scope, "production-provider-readback");
  assert.equal(readback.settingsDigest, publicDigest(readback.snapshot));
  const observed = time(readback.observedAt);
  assert.ok(observed <= now && now - observed <= 5000, "Fresh production parent required");
  const s = readback.snapshot;
  for (const [key, value] of Object.entries(productionTarget)) assert.equal(s[key], value);
  assert.equal(s.workersDev, false);
  assert.deepEqual([...s.secretNames].sort(), [...enrollment.configuration.secretNames].sort());
  assert.ok(Array.isArray(s.publicBindings));
  if (enrollment.mode === "first-cutover") {
    const expected = enrollment.approval.baseline;
    assert.equal(s.workerTag, expected.workerTag);
    assert.equal(s.createdOn, expected.createdOn);
    assert.equal(readback.settingsDigest, expected.settingsDigest);
    // Preprovisioned inert bootstrap, not the historical zero-secret inactive baseline.
    assert.deepEqual(s.crons, []);
    assert.ok(s.routes.every((r) => r.script !== "hive"));
    assert.ok(s.domains.every((d) => d.service !== "hive"));
    const publicBindings = s.publicBindings.filter(
      (b) => !["secret_text", "secret_key", "assets"].includes(b.type),
    );
    assert.deepEqual(publicBindings, [
      { name: "HIVE_NATIVE_MODE", type: "plain_text", text: "bootstrap" },
    ]);
  } else {
    assert.ok(
      enrollment.approval.allowedParents.some(
        (p) =>
          p.workerTag === s.workerTag &&
          p.createdOn === s.createdOn &&
          p.publicConfigurationDigest === s.publicConfigurationDigest,
      ),
      "Production parent/configuration drift",
    );
    assert.equal(s.versionPreviews, false);
    assert.ok(
      s.publicBindings.some(
        (b) => b.name === "HIVE_NATIVE_MODE" && b.type === "plain_text" && b.text === "production",
      ),
    );
    assert.ok(
      s.publicBindings.some(
        (b) =>
          b.name === "HIVE_NATIVE_PRODUCTION_ACTIVE" &&
          b.type === "plain_text" &&
          b.text === "true",
      ),
    );
    const ownRoutes = s.routes.filter((r) => r.script === "hive");
    assert.equal(ownRoutes.length, 1);
    assert.equal(ownRoutes[0].pattern, enrollment.configuration.route.pattern);
    assert.ok(s.domains.every((d) => d.service !== "hive"));
  }
}

// Fixed public repository read. No token creation, credential input or ref chosen
// by the enrollment. Git transport is bounded and never prompts interactively.
export function verifyRemoteMain(commit, execute = execFileSync) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const result = execute(
    "git",
    ["ls-remote", "--exit-code", "https://github.com/kethalia/hive.git", "refs/heads/main"],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(
    result,
    `${commit}\trefs/heads/main\n`,
    "Build is no longer the current remote main",
  );
}

// One invocation/effect. A missing acknowledgement is surfaced to Builds; this
// helper never retries or reconciles by issuing a second deployment.
export async function publishManagedProduction({
  enrollment,
  assertReady,
  verifyMain,
  observe = collectProductionReadback,
  token,
  execute,
  now = Date.now,
}) {
  await verifyMain();
  await assertReady();
  const readback = await observe({ token });
  // Recheck after build/observation latency, then require the parent read still fresh.
  // This observes freshness; it cannot provide an atomic cross-provider CAS.
  await verifyMain();
  verifyProductionParent(enrollment, readback, now());
  assert.ok(now() < time(enrollment.approval.expiresAt));
  await execute();
}
