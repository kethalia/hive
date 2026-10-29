import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertBuildReady } from "./build-integrity.mjs";
import { readPreviewPrivateJson } from "./deployment-identity.mjs";
import {
  validatePreflight,
  validatePreviewConfiguration,
  validateRuntimeDatabase,
} from "./deployment-plan.mjs";
import { assertPreparedArtifact } from "./prepared-artifact.mjs";

// Local artifact guard. The primary also rechecks connected-API ownership
// immediately before an authorized upload. Default invocation is a dry run.
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const [manifestPath, kind] = process.argv.slice(2);
  assert.ok(["app", "auth"].includes(kind));
  const record = await readPreviewPrivateJson(manifestPath),
    configs = {},
    secrets = {},
    observed = {};
  for (const name of ["app", "auth"]) {
    configs[name] = await readPreviewPrivateJson(record.configs[name].configFile);
    secrets[name] = await readPreviewPrivateJson(record.configs[name].secretFile);
    observed[name] = {
      configSHA256: digest(await readFile(record.configs[name].configFile)),
      secretFileSHA256: digest(await readFile(record.configs[name].secretFile)),
      secretNames: Object.keys(secrets[name]).sort(),
    };
    assert.equal(configs[name].account_id, record.accountId);
    assert.equal(configs[name].vars.SOURCE_REVISION, record.sourceRevision);
    assert.equal(configs[name].main, resolve(`deploy/cloudflare/${name}/worker.ts`));
    const expected = [
      "DATABASE_URL",
      "AUTH_SERVICE_SECRET",
      "ENCRYPTION_KEY",
      ...(name === "app"
        ? [
            "COOKIE_SECRET",
            "PREVIEW_BEARER",
            "PREVIEW_COOKIE_SECRET",
            ...(record.nativeIssuer ? ["HIVE_CODEX_ISSUER_PRIVATE_KEY"] : []),
          ]
        : []),
    ].sort();
    assert.deepEqual(observed[name].secretNames, expected);
  }
  validatePreviewConfiguration(configs.app, configs.auth);
  assert.equal(configs.app.assets.directory, resolve(".open-next/assets"));
  validateRuntimeDatabase(secrets.app.DATABASE_URL);
  assert.equal(secrets.app.DATABASE_URL, secrets.auth.DATABASE_URL);
  assert.equal(secrets.app.AUTH_SERVICE_SECRET, secrets.auth.AUTH_SERVICE_SECRET);
  assert.equal(secrets.app.ENCRYPTION_KEY, secrets.auth.ENCRYPTION_KEY);
  assert.equal(
    configs.app.vars.HIVE_CODEX_GATEWAY_ENABLED,
    record.nativeGatewayCandidate ? "true" : "false",
  );
  const ready = await assertBuildReady();
  assertPreparedArtifact(record, {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    readinessSHA256: digest(await readFile(".open-next/hive-build-ready.json")),
    sourceInputSetSHA256: digest(JSON.stringify(ready.inputs)),
    artifactSetSHA256: digest(JSON.stringify(ready.outputs)),
    configs: observed,
  });
  const previous =
    record.deploymentMode === "update-preview"
      ? JSON.parse(
          execFileSync(
            "git",
            ["show", "HEAD:docs/checks/autonomous-delivery/cloudflare-app-deployment.json"],
            { encoding: "utf8" },
          ),
        )
      : undefined;
  const preflight = JSON.parse(
    await readFile("docs/checks/autonomous-delivery/cloudflare-app-preflight.json", "utf8"),
  );
  validatePreflight(preflight, Date.now(), previous);
  assert.ok(record.maxScriptedRequests <= preflight.approvedProbeRequestMaximum);
  if (process.argv.includes("--check-only")) {
    console.log(
      JSON.stringify({
        localArtifactVerified: true,
        sourceRevision: record.sourceRevision,
        cloudWrites: 0,
      }),
    );
  } else {
    const directory = dirname(manifestPath),
      output = join(directory, "bundles", kind);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const deploy = process.argv.includes("--deploy"),
      logFile = join(directory, `${kind}-${deploy ? "deploy" : "dry-run"}-${Date.now()}.log`);
    const log = await open(logFile, "wx", 0o600);
    let result;
    try {
      result = spawnSync(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          record.configs[kind].configFile,
          "--secrets-file",
          record.configs[kind].secretFile,
          "--outdir",
          output,
          ...(deploy ? [] : ["--dry-run"]),
        ],
        {
          stdio: ["ignore", log.fd, log.fd],
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        },
      );
    } finally {
      await log.close();
    }
    console.log(
      JSON.stringify({
        sourceRevision: record.sourceRevision,
        worker: record.configs[kind].name,
        localArtifactVerified: true,
        cloudDeploymentAttempted: deploy,
        exitCode: result.status,
        logFile,
        bundleDirectory: output,
        secretsPrinted: false,
      }),
    );
    process.exitCode = result.status ?? 1;
  }
} catch {
  console.error(
    "Prepared deployment rejected: verify source/artifact/config/bindings, fresh ownership/headroom and private file permissions. No secrets printed.",
  );
  process.exitCode = 1;
}
