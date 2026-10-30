import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertBuildReady } from "./build-integrity.mjs";
import {
  loadPreviewIdentity,
  previewIdentityScope,
  previewRuntimeBindings,
} from "./deployment-identity.mjs";
import {
  ACCOUNT_ID,
  APP_NAME,
  AUTH_NAME,
  validatePreflight,
  validatePreviewConfiguration,
  validateRuntimeDatabase,
} from "./deployment-plan.mjs";
import { loadPreviewHostIdentity } from "./host-identity.mjs";
import {
  workspaceProjectsCandidate,
  workspaceProjectsVars,
} from "./workspace-projects-candidate.mjs";

// Preparation only: no Cloudflare write, public URL, route, schedule or key operation.
const digest = (value) => createHash("sha256").update(value).digest("hex");
try {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const updating = process.argv.includes("--update-preview");
  const nativeCandidate = process.argv.includes("--native-gateway-candidate");
  const projectsCandidate = process.argv.includes("--workspace-projects-candidate");
  const previous = updating
    ? JSON.parse(
        execFileSync(
          "git",
          ["show", "HEAD:docs/checks/autonomous-delivery/cloudflare-app-deployment.json"],
          { encoding: "utf8" },
        ),
      )
    : undefined;
  assert.ok(
    !updating || !process.argv.includes("--create-preview-identity"),
    "Never create replacement keys while updating a preview",
  );
  const preflight = JSON.parse(
    await readFile("docs/checks/autonomous-delivery/cloudflare-app-preflight.json", "utf8"),
  );
  validatePreflight(preflight, Date.now(), previous);
  const ready = await assertBuildReady();
  const readyBytes = await readFile(".open-next/hive-build-ready.json");
  const proof = JSON.parse(
    await readFile("docs/checks/autonomous-delivery/cloudflare-auth-app.json", "utf8"),
  );
  assert.equal(proof.testedRevision, revision, "Run the app proof at this committed revision");
  assert.equal(proof.testedSourceCommitted, true);
  assert.equal(proof.sourceStable, true);
  assert.equal(proof.result.ok, true);
  assert.equal(proof.serviceBindingTransportVerified, true);
  assert.equal(proof.result.appChecks.privatePreviewGuardBeforeFramework, true);
  assert.equal(proof.result.appChecks.privateStaticAssetsGuardAndNoStore, true);
  assert.equal(proof.result.appChecks.privatePreviewCookieBootstrapAndAsset, true);
  if (nativeCandidate) {
    assert.equal(updating, true, "Native gateway activation requires an existing owned preview");
    for (const name of [
      "nativeRegistrationTransportRejectsForgedIssuer",
      "nativeCallbackIssuerConfigurationVerified",
      "nativeHeartbeatRejectsUnknownRegistration",
      "nativeCallbackExceptionRemainsExactAndPrivate",
    ])
      assert.equal(
        proof.result.appChecks[name],
        true,
        "Run the actual local callback policy proof first",
      );
  }
  assert.equal(
    proof.appBuildReadySHA256,
    digest(readyBytes),
    "Proof must identify this ready artifact",
  );
  for (const [path, expected] of Object.entries(proof.sourceDigests))
    assert.equal(digest(await readFile(path)), expected, "Tested source changed");
  const dirty = execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "src",
      "packages",
      "public",
      "services/auth/src",
      "deploy/cloudflare/app",
      "deploy/cloudflare/auth",
      "package.json",
      "pnpm-lock.yaml",
      "next.config.ts",
      "open-next.config.ts",
      "tsconfig.json",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(dirty, "", "Commit source before preparing a preview");
  const app = JSON.parse(await readFile("deploy/cloudflare/app/wrangler.jsonc", "utf8"));
  const auth = JSON.parse(await readFile("deploy/cloudflare/auth/wrangler.jsonc", "utf8"));
  validatePreviewConfiguration(app, auth);
  const credentials = process.env.HIVE_PREVIEW_CREDENTIAL_DIRECTORY ?? "/tmp/hive-epic-coder-auth";
  const databaseUrl = (
    await readFile(join(credentials, "neon-app-preview-runtime-url"), "utf8")
  ).trim();
  validateRuntimeDatabase(databaseUrl);
  const identityFile = process.env.HIVE_PREVIEW_IDENTITY_FILE;
  assert.ok(typeof identityFile === "string" && isAbsolute(identityFile));
  const identityRelative = relative(process.cwd(), identityFile);
  assert.ok(
    identityRelative.startsWith("../") || isAbsolute(identityRelative),
    "Private preview identity must remain outside the checkout",
  );
  const identity = await loadPreviewIdentity(identityFile, previewIdentityScope(databaseUrl), {
    createIfMissing: process.argv.includes("--create-preview-identity"),
  });
  if (previous)
    assert.equal(
      identity.identityId,
      previous.prepared.previewIdentityId,
      "Existing preview identity must be retained",
    );
  const previewOrigin = `https://${APP_NAME}.${preflight.workersSubdomain}.workers.dev`;
  const hostIdentityFile = process.env.HIVE_PREVIEW_HOST_IDENTITY_FILE;
  assert.ok(!nativeCandidate || hostIdentityFile, "Choose the private scoped host identity");
  let hostIdentity;
  if (hostIdentityFile) {
    const outside = relative(process.cwd(), hostIdentityFile);
    assert.ok(isAbsolute(hostIdentityFile) && (outside.startsWith("../") || isAbsolute(outside)));
    assert.equal(app.vars.CODER_URL, auth.vars.CODER_URL);
    hostIdentity = await loadPreviewHostIdentity(
      hostIdentityFile,
      previewOrigin,
      app.vars.CODER_URL,
    );
  }
  const priorIssuer = previous?.nativeIssuer ?? previous?.prepared?.nativeIssuer;
  if (priorIssuer) {
    assert.ok(hostIdentity, "Retain the existing preview issuer identity");
    assert.equal(hostIdentity.keyId, priorIssuer.keyId);
    assert.equal(hostIdentity.publicKeySHA256, priorIssuer.publicKeySHA256);
    assert.deepEqual(hostIdentity.scope, priorIssuer.scope);
  } else if (
    previous?.workers.app.bindings.some(
      (binding) => binding.name === "HIVE_CODEX_ISSUER_PRIVATE_KEY",
    )
  )
    throw new Error("Existing issuer lacks ownership evidence");
  const workspaceCandidate = workspaceProjectsCandidate({
    enabled: projectsCandidate,
    updating,
    nativeCandidate,
    issuer: hostIdentity,
    manifestSha256: (
      await readFile("templates/ai-dev-k8s/assets/workspace-read.manifest.sha256", "utf8")
    ).trim(),
  });
  const runId = randomUUID();
  const directory = join(credentials, `app-preview-${runId}`);
  await mkdir(directory, { mode: 0o700 });
  const bindings = previewRuntimeBindings(identity, databaseUrl);
  if (hostIdentity) bindings.app.HIVE_CODEX_ISSUER_PRIVATE_KEY = hostIdentity.privateKeyPem;
  if (workspaceCandidate)
    bindings.app.HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY = hostIdentity.privateKeyPem;
  const configs = {};
  for (const [kind, config] of Object.entries({ app, auth })) {
    delete config.$schema;
    config.main = resolve(`deploy/cloudflare/${kind}/worker.ts`);
    config.account_id = ACCOUNT_ID;
    if (config.assets) config.assets.directory = resolve(".open-next/assets");
    config.vars = {
      ...config.vars,
      SOURCE_REVISION: revision,
      ...(kind === "app" ? { HIVE_DELIVERY_ENABLED: "true" } : {}),
      ...(kind === "app"
        ? {
            HIVE_PREVIEW_ORIGIN: previewOrigin,
            HIVE_CODEX_GATEWAY_ENABLED: nativeCandidate ? "true" : "false",
            ...workspaceProjectsVars(workspaceCandidate, hostIdentity),
          }
        : {}),
      ...(kind === "app" && hostIdentity
        ? {
            HIVE_CODEX_ISSUER_KEY_ID: hostIdentity.keyId,
            HIVE_CODEX_ISSUER_PUBLIC_KEY: hostIdentity.publicKeyPem,
            HIVE_CODEX_HIVE_ORIGIN: previewOrigin,
            HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: hostIdentity.scope.templateId,
            HIVE_CODEX_APP_SLUG: "codex-session",
            HIVE_CODEX_GATEWAY_PORT: "13341",
            HIVE_CODEX_SESSION_TRANSPORT: "relay",
          }
        : {}),
    };
    const configFile = join(directory, `${kind}.jsonc`);
    const secretFile = join(directory, `${kind}-secrets.json`);
    const configBytes = `${JSON.stringify(config, null, 2)}\n`;
    const secretBytes = JSON.stringify(bindings[kind]);
    await writeFile(configFile, configBytes, { flag: "wx", mode: 0o600 });
    await writeFile(secretFile, secretBytes, { flag: "wx", mode: 0o600 });
    configs[kind] = {
      name: config.name,
      configFile,
      secretFile,
      configSHA256: digest(configBytes),
      secretNames: Object.keys(bindings[kind]).sort(),
      secretFileSHA256: digest(secretBytes),
    };
  }
  const record = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    sourceRevision: revision,
    deploymentMode: updating ? "update-preview" : "new-preview",
    previousWorkers: previous
      ? {
          identities: previous.scriptIdentities,
          deployments: Object.fromEntries(
            Object.entries(previous.workers).map(([kind, worker]) => [
              kind,
              { name: worker.name, deploymentId: worker.deploymentId, versionId: worker.versionId },
            ]),
          ),
        }
      : undefined,
    nativeGatewayCandidate: nativeCandidate,
    workspaceProjectsCandidate: workspaceCandidate,
    nativeIssuer: hostIdentity
      ? {
          keyId: hostIdentity.keyId,
          publicKeySHA256: hostIdentity.publicKeySHA256,
          scope: hostIdentity.scope,
        }
      : undefined,
    previewIdentityId: identity.identityId,
    previewIdentityScopeSHA256: digest(JSON.stringify(identity.scope)),
    runId,
    accountId: ACCOUNT_ID,
    workerNames: [APP_NAME, AUTH_NAME],
    configs,
    preflightObservedAt: preflight.observedAt,
    readinessSHA256: digest(readyBytes),
    sourceInputSetSHA256: digest(JSON.stringify(ready.inputs)),
    artifactSetSHA256: digest(JSON.stringify(ready.outputs)),
    maxScriptedRequests: preflight.approvedProbeRequestMaximum,
    publicUrlsEnabled: false,
    additionalCostsAuthorized: false,
    noCloudWrites: true,
  };
  await writeFile(
    join(directory, "prepared-deployment.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      prepared: true,
      sourceRevision: revision,
      accountId: ACCOUNT_ID,
      preparationDirectory: directory,
      workerNames: record.workerNames,
      maxScriptedRequests: record.maxScriptedRequests,
      cloudWrites: 0,
      secretsPrinted: false,
    }),
  );
} catch {
  console.error(
    "Private preview preparation rejected: verify committed source, guarded proof, fresh account headroom and isolated runtime configuration. No secrets printed.",
  );
  process.exitCode = 1;
}
