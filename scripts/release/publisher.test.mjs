import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { packReleaseArtifact } from "./artifact.mjs";
import { publishRelease } from "./publisher.mjs";

const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const digest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const target = {
  accountId: "a".repeat(32),
  environment: "preview",
  scripts: { app: "fixed-app", auth: "fixed-auth" },
  hiveReleaseWriter: true,
};
const templateBindings = [
  { name: "HIVE_RELEASE_SOURCE_SHA", text: "{{source_sha}}", type: "plain_text" },
  { name: "HIVE_RELEASE_ARTIFACT_DIGEST", text: "{{artifact_digest}}", type: "plain_text" },
];
const configDigest = digest({ bindings: templateBindings, runtime: {} });
const component = {
  expectedConfigDigest: configDigest,
  metadata: {
    compatibility_date: "2026-01-01",
    compatibility_flags: [],
    bindings: templateBindings,
  },
};
const config = {
  controllerOrigin: "https://controller.example",
  audiencePrefix: "urn:hive:release-build:preview:",
  target,
  targetDigest: digest(target),
  components: { app: component, auth: component },
};
const identity = {
  repositoryId: "1",
  repositoryOwnerId: "2",
  mergeSha: "a".repeat(40),
  runId: "3",
  runAttempt: 1,
};
const archive = await packReleaseArtifact(
  new Map([
    ["app/worker.js", Buffer.from("app")],
    ["auth/worker.js", Buffer.from("auth")],
    ["assets/index.html", Buffer.from("asset")],
  ]),
);
const releaseId = "00000000-0000-4000-8000-000000000001",
  ownerId = "00000000-0000-4000-8000-000000000002",
  version = "00000000-0000-4000-8000-000000000003";
test("publisher binds challenge, fixed uploads, readbacks and final OIDC manifest", async () => {
  const calls = [];
  let writtenBindings;
  const fetcher = async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.redirect, "error");
    if (url.startsWith("https://pipelines.actions.githubusercontent.com/"))
      return Response.json({ value: "fixture-oidc" });
    if (url.endsWith("/challenge")) {
      assert.equal(init.headers.Authorization, `Bearer ${"f".repeat(64)}`);
      assert.equal(init.headers["X-Hive-Release-OIDC"], "fixture-oidc");
      const body = JSON.parse(init.body);
      assert.equal(body.targetDigest, config.targetDigest);
      return Response.json({
        releaseId,
        ownerId,
        targetDigest: config.targetDigest,
        publisherConfigDigest: digest(config),
        mergeSha: identity.mergeSha,
      });
    }
    if (url.endsWith("/attestation")) {
      const manifest = JSON.parse(init.body);
      assert.equal(manifest.app.script, "fixed-app");
      assert.equal(manifest.auth.script, "fixed-auth");
      return Response.json({ releaseId, manifestDigest: digest(manifest) });
    }
    if (url.endsWith("/assets-upload-session"))
      return Response.json({ success: true, result: { jwt: "completed", buckets: [] } });
    if (url.includes("/versions?") && init.method === "POST") {
      writtenBindings = JSON.parse(init.body.get("metadata")).bindings;
      return Response.json({ success: true, result: { id: version } });
    }
    if (url.includes(`/versions/${version}`) && init.method === "GET")
      return Response.json({
        success: true,
        result: {
          id: version,
          resources: { bindings: writtenBindings, script_runtime: {}, script: { etag: "opaque" } },
        },
      });
    throw Error("unexpected URL");
  };
  const receipt = await publishRelease({
    config,
    identity,
    archive,
    oidcUrl: "https://pipelines.actions.githubusercontent.com/oidc?x=y",
    oidcRequestToken: "fixture",
    cloudflareToken: "fixture",
    previewBearer: "f".repeat(64),
    fetcher,
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(receipt.releaseId, releaseId);
  assert.equal(calls.filter(([url]) => url.includes("/deployments")).length, 0);
});
test("publisher rejects foreign OIDC origin and target changes before any request", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw Error("unexpected");
  };
  const options = {
    config,
    identity,
    archive,
    oidcUrl: "https://evil.example/oidc",
    oidcRequestToken: "fixture",
    cloudflareToken: "fixture",
    fetcher,
    signal: AbortSignal.timeout(1000),
  };
  await assert.rejects(publishRelease(options), /publisher_config/);
  await assert.rejects(
    publishRelease({
      ...options,
      oidcUrl: "https://pipelines.actions.githubusercontent.com/oidc",
      config: { ...config, targetDigest: "0".repeat(64) },
    }),
    /publisher_config/,
  );
  assert.equal(calls, 0);
});

test("single topology uploads exactly one artifact and attests one identical physical version", async () => {
  const singleTarget = {
    ...target,
    environment: "production",
    topology: "single",
    scripts: { app: "hive", auth: "hive" },
  };
  const singleConfig = {
    ...config,
    target: singleTarget,
    targetDigest: digest(singleTarget),
    components: { app: component },
  };
  const oneArchive = await packReleaseArtifact(
    new Map([
      ["app/worker.js", Buffer.from("one")],
      ["assets/index.html", Buffer.from("asset")],
    ]),
  );
  let requests = 0,
    uploads = 0,
    writtenBindings;
  const fetcher = async (url, init) => {
    requests++;
    if (url.startsWith("https://pipelines.actions.githubusercontent.com/"))
      return Response.json({ value: "fixture-oidc" });
    if (url.endsWith("/challenge"))
      return Response.json({
        releaseId,
        ownerId,
        targetDigest: singleConfig.targetDigest,
        publisherConfigDigest: digest(singleConfig),
        mergeSha: identity.mergeSha,
      });
    if (url.endsWith("/attestation")) {
      const manifest = JSON.parse(init.body);
      assert.equal(manifest.topology, "single");
      assert.deepEqual(manifest.app, manifest.auth);
      return Response.json({ releaseId, manifestDigest: digest(manifest) });
    }
    if (url.endsWith("/assets-upload-session"))
      return Response.json({ success: true, result: { jwt: "completed", buckets: [] } });
    if (url.includes("/versions?") && init.method === "POST") {
      uploads++;
      assert.match(url, /\/scripts\/hive\//);
      writtenBindings = JSON.parse(init.body.get("metadata")).bindings;
      return Response.json({ success: true, result: { id: version } });
    }
    if (url.includes(`/versions/${version}`) && init.method === "GET")
      return Response.json({
        success: true,
        result: {
          id: version,
          resources: { bindings: writtenBindings, script_runtime: {}, script: { etag: "opaque" } },
        },
      });
    throw Error("unexpected URL");
  };
  const options = {
    config: singleConfig,
    identity,
    archive: oneArchive,
    oidcUrl: "https://pipelines.actions.githubusercontent.com/oidc",
    oidcRequestToken: "fixture",
    cloudflareToken: "fixture",
    fetcher,
    signal: AbortSignal.timeout(1000),
  };
  await publishRelease(options);
  assert.equal(uploads, 1);
  await assert.rejects(publishRelease({ ...options, archive }), /artifact_missing_worker/);
  assert.equal(uploads, 1);
  const previewTarget = { ...singleTarget, environment: "preview" };
  const beforePreview = requests;
  await assert.rejects(
    publishRelease({
      ...options,
      config: { ...singleConfig, target: previewTarget, targetDigest: digest(previewTarget) },
    }),
    /publisher_config/,
  );
  assert.equal(uploads, 1);
  assert.equal(requests, beforePreview);
});
