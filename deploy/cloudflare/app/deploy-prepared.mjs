import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertBuildReady } from "./build-integrity.mjs";
import { assertDeliveryPilot, projectJobsPilotPlan } from "./delivery-pilot-candidate.mjs";
import { readPreviewPrivateJson } from "./deployment-identity.mjs";
import {
  validatePreflight,
  validatePreviewConfiguration,
  validateRuntimeDatabase,
} from "./deployment-plan.mjs";
import { previousAfterAuthUpload, validateInheritedPreview } from "./inherited-preview.mjs";
import { assertPreparedArtifact } from "./prepared-artifact.mjs";
import { assertWorkspaceProjectsCandidate } from "./workspace-projects-candidate.mjs";

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
            ...(record.workspaceProjectsCandidate
              ? ["HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY"]
              : []),
          ]
        : []),
    ].sort();
    assert.deepEqual(
      observed[name].secretNames,
      record.inheritedPreviewSecrets
        ? name === "app"
          ? [
              "PREVIEW_BEARER",
              "PREVIEW_COOKIE_SECRET",
              ...(record.deliveryPilotCandidate ? ["HIVE_PROJECT_TASK_RECONCILE_SECRET"] : []),
            ].sort()
          : []
        : expected,
    );
    for (const secretName of observed[name].secretNames)
      assert.equal(configs[name].vars[secretName], undefined);
  }
  validatePreviewConfiguration(configs.app, configs.auth);
  if (record.deliveryPilotCandidate) {
    const pins = Object.fromEntries(
      await Promise.all(
        Object.entries({
          workspace: "workspace-read.manifest.sha256",
          voice: "voice.manifest.sha256",
          agent: "agent-bridge.manifest.sha256",
          helper: "agent-bridge.helper.sha256",
        }).map(async ([key, path]) => [
          key,
          (await readFile(`templates/ai-dev-k8s/assets/${path}`, "utf8")).trim(),
        ]),
      ),
    );
    assertDeliveryPilot(record, configs.app, secrets.app, pins);
    assert.deepEqual(
      record.projectJobsPlan,
      projectJobsPilotPlan(secrets.app.HIVE_PROJECT_TASK_RECONCILE_SECRET, record.sourceRevision),
    );
  } else
    assertWorkspaceProjectsCandidate(
      record,
      configs.app,
      secrets.app,
      (await readFile("templates/ai-dev-k8s/assets/workspace-read.manifest.sha256", "utf8")).trim(),
    );
  assert.equal(configs.app.assets.directory, resolve(".open-next/assets"));
  if (!record.inheritedPreviewSecrets) {
    validateRuntimeDatabase(secrets.app.DATABASE_URL);
    assert.equal(secrets.app.DATABASE_URL, secrets.auth.DATABASE_URL);
    assert.equal(secrets.app.AUTH_SERVICE_SECRET, secrets.auth.AUTH_SERVICE_SECRET);
    assert.equal(secrets.app.ENCRYPTION_KEY, secrets.auth.ENCRYPTION_KEY);
  }
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
  if (record.inheritedPreviewSecrets) {
    assert.equal(record.deploymentMode, "update-preview");
    assert.equal(record.previewIdentityId, previous.prepared.previewIdentityId);
    const evidence = await readPreviewPrivateJson(process.env.HIVE_PREVIEW_PROVIDER_EVIDENCE_FILE);
    let expectedPrevious = previous;
    if (kind === "app" && process.argv.includes("--deploy")) {
      // The operator records the verified auth upload before starting the app upload.
      const receipt = await readPreviewPrivateJson(
        process.env.HIVE_PREVIEW_FIRST_UPLOAD_RECEIPT_FILE,
      );
      expectedPrevious = previousAfterAuthUpload(previous, record, receipt);
    }
    const issuer = validateInheritedPreview(
      evidence,
      expectedPrevious,
      Date.now(),
      kind === "app" && process.argv.includes("--deploy") ? { auth: record.sourceRevision } : {},
    );
    assert.equal(configs.app.vars.HIVE_CODEX_ISSUER_PUBLIC_KEY, issuer.publicKeyPem);
    for (const target of evidence.targets)
      for (const binding of target.bindings)
        if (binding.type === "secret_text")
          assert.equal(
            configs[target.name === record.configs.app.name ? "app" : "auth"].vars[binding.name],
            undefined,
          );
  }

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
