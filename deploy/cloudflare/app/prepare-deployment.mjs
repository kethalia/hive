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
  MAX_REQUESTS,
  validatePreflight,
  validatePreviewConfiguration,
  validateRuntimeDatabase,
} from "./deployment-plan.mjs";

// Preparation only: no Cloudflare write, public URL, route, schedule or key operation.
const digest = (value) => createHash("sha256").update(value).digest("hex");
try {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const preflight = JSON.parse(
    await readFile("docs/checks/autonomous-delivery/cloudflare-app-preflight.json", "utf8"),
  );
  validatePreflight(preflight);
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
  const runId = randomUUID();
  const directory = join(credentials, `app-preview-${runId}`);
  await mkdir(directory, { mode: 0o700 });
  const bindings = previewRuntimeBindings(identity, databaseUrl);
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
        ? { HIVE_PREVIEW_ORIGIN: `https://${APP_NAME}.${preflight.workersSubdomain}.workers.dev` }
        : {}),
    };
    const configFile = join(directory, `${kind}.jsonc`);
    const secretFile = join(directory, `${kind}-secrets.json`);
    const configBytes = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(configFile, configBytes, { flag: "wx", mode: 0o600 });
    await writeFile(secretFile, JSON.stringify(bindings[kind]), { flag: "wx", mode: 0o600 });
    configs[kind] = {
      name: config.name,
      configFile,
      secretFile,
      configSHA256: digest(configBytes),
    };
  }
  const record = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    sourceRevision: revision,
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
    maxScriptedRequests: MAX_REQUESTS,
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
      maxScriptedRequests: MAX_REQUESTS,
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
