import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  type NativePublicationReceipt,
  nativeDigest,
  nativePublicationGrantSchema,
} from "../../src/lib/delivery/release-native-preview-contracts";
import { packReleaseArtifact } from "./artifact.mjs";
import { downloadNativeArtifact, nativeArchiveFromZip } from "./native-preview-artifact-download";
import {
  archive,
  callerWorkflowBytes,
  config,
  publicConfig,
  publisher,
  scope,
  target,
  uuid,
  zipArchive,
} from "./native-preview-fixture";
import { publishNativePreview } from "./native-preview-publisher";
import {
  inspectNativeArchive,
  nativeAssetHash,
  sha256,
  uploadNativePreview,
} from "./native-preview-upload";

async function fixture() {
  const bytes = await archive(),
    inspected = await inspectNativeArchive(bytes),
    zip = zipArchive(bytes);
  const artifact = {
    schemaVersion: 1,
    provider: "cloudflare-native-preview",
    id: scope.artifactId,
    ownerId: scope.ownerId,
    releaseId: scope.releaseId,
    targetDigest: nativeDigest(target),
    sourceSha: scope.sourceSha,
    archiveDigest: inspected.archiveDigest,
    artifactDigest: inspected.artifactDigest,
    moduleManifestDigest: inspected.moduleManifestDigest,
    assetsManifestDigest: inspected.assetsManifestDigest,
    builder: {
      repositoryId: "1",
      repositoryOwnerId: "2",
      runId: "4",
      runAttempt: 1,
      artifactId: "5",
      artifactZipDigest: sha256(zip),
      workflowId: "3",
    },
    publicConfig,
    privateBindingRevision: uuid(10),
    compatibilityRevision: uuid(12),
  };
  const grant = nativePublicationGrantSchema.parse({
    schemaVersion: 1,
    provider: "cloudflare-native-preview",
    id: uuid(11),
    purpose: "bootstrap-baseline",
    actionId: scope.artifactId,
    releaseId: scope.releaseId,
    ownerId: scope.ownerId,
    generation: 1,
    requestDigest: "d".repeat(64),
    target,
    artifact,
    publisher,
    expectedCurrentDeploymentId: "old-deployment",
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
  });
  const events: string[] = [],
    captured = {
      metadata: null as Record<string, unknown> | null,
      receipt: null as NativePublicationReceipt | null,
    };
  const state = {
    current: "old-deployment",
    lostAck: false,
    grantLostAck: false,
    receiptLostAck: false,
    invalidBucket: false,
    pauseAfterAssets: false,
    grantIssued: false,
    invalidGrant: false,
    buildRunning: false,
    buildRerun: false,
    callerChanged: false,
    wrongCallerRef: false,
    foreignBuild: false,
    wrongZipDigest: false,
    missingCreatedAt: false,
  };
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    events.push(`${init?.method ?? "GET"} ${path}`);
    assert.equal(init?.redirect, "manual");
    if (path.startsWith("https://pipelines.actions.githubusercontent.com/"))
      return Response.json({ value: "fixture.oidc.token" });
    if (path.startsWith("https://controller.example")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).get("X-Hive-Release-OIDC"), "fixture.oidc.token");
      if (path.endsWith("/artifact")) {
        assert.deepEqual(body, artifact);
        return Response.json({ artifactId: artifact.id, actionId: artifact.id });
      }
      if (path.endsWith("/grant")) {
        if (state.grantIssued) return new Response(null, { status: 503 });
        state.grantIssued = true;
        if (state.grantLostAck) throw Error("lost grant ACK");
        return Response.json(
          state.invalidGrant ? { ...grant, publisher: { ...publisher, runId: "88" } } : grant,
        );
      }
      if (path.endsWith("/reauthorize")) {
        if (
          state.pauseAfterAssets &&
          events.some((event) => event.endsWith("assets-upload-session"))
        )
          return new Response(null, { status: 503 });
        return Response.json({ authorized: true, grantDigest: nativeDigest(grant) });
      }
      if (path.endsWith("/receipt")) {
        captured.receipt = body;
        if (state.receiptLostAck) throw Error("lost stored receipt ACK");
        return Response.json({ stored: true, receiptDigest: nativeDigest(body) });
      }
    }
    if (path.endsWith("/actions/runs/4/attempts/1") || path.endsWith("/actions/runs/4"))
      return Response.json({
        id: 4,
        run_attempt: state.buildRerun && path.endsWith("/actions/runs/4") ? 2 : 1,
        event: "push",
        path: `${config.builderPolicy.callerWorkflowPath}@${state.wrongCallerRef ? "main" : "codex/delivery-system-design"}`,
        head_branch: "codex/delivery-system-design",
        workflow_id: 3,
        status: state.buildRunning ? "in_progress" : "completed",
        conclusion: "success",
        head_sha: state.foreignBuild ? "e".repeat(40) : scope.sourceSha,
        repository: { id: 1 },
        head_repository: { id: 1 },
        referenced_workflows: [
          {
            path: config.builderPolicy.reusableWorkflowPath,
            sha: config.builderPolicy.workflowSha,
          },
        ],
      });
    if (
      path ===
      `https://api.github.com/repos/kethalia/hive/contents/${config.builderPolicy.callerWorkflowPath}?ref=${scope.sourceSha}`
    ) {
      const content = state.callerChanged
        ? Buffer.concat([callerWorkflowBytes, Buffer.from("# modified caller\n")])
        : callerWorkflowBytes;
      return Response.json({
        type: "file",
        encoding: "base64",
        path: config.builderPolicy.callerWorkflowPath,
        sha: config.builderPolicy.callerWorkflowBlobSha,
        size: content.length,
        content: content.toString("base64"),
      });
    }
    if (path.endsWith("/actions/artifacts/5"))
      return Response.json({
        id: 5,
        name: "hive-native-release",
        expired: false,
        digest: `sha256:${state.wrongZipDigest ? "0".repeat(64) : sha256(zip)}`,
        size_in_bytes: zip.length,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        workflow_run: { id: 4, repository_id: 1, head_repository_id: 1, head_sha: scope.sourceSha },
      });
    if (path.endsWith("/actions/artifacts/5/zip"))
      return new Response(null, {
        status: 302,
        headers: { Location: "https://fixture.blob.core.windows.net/release.zip?sig=hidden" },
      });
    if (path.startsWith("https://fixture.blob.core.windows.net/")) {
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      return new Response(new Uint8Array(zip));
    }
    if (path.includes("api.cloudflare.com/")) {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-cloudflare");
      if (path.endsWith("assets-upload-session"))
        return Response.json({
          success: true,
          result: { jwt: "completed", buckets: state.invalidBucket ? [["unknown"]] : [] },
        });
      if (path.endsWith("deployments/latest"))
        return Response.json({ success: true, result: { id: state.current } });
      if (path.endsWith("/deployments") && init?.method === "POST") {
        assert.ok(init.body instanceof FormData);
        captured.metadata = JSON.parse(String(init.body.get("metadata")));
        const modules = init.body.getAll("files") as File[];
        assert.deepEqual(
          modules.map((file) => file.name),
          ["_headers", "module.wasm", "worker.js"],
        );
        assert.equal(init.body.get("worker.js"), null);
        if (state.lostAck) throw Error("lost CF ACK");
        return Response.json({
          success: true,
          result: {
            id: "new-deployment",
            ...(state.missingCreatedAt ? {} : { created_on: new Date().toISOString() }),
            env: { DATABASE_URL: { type: "secret_text", text: "never-persist" } },
          },
        });
      }
      if (path.endsWith("previews/codex%2Fdelivery-system-design"))
        return Response.json({
          success: true,
          result: { id: target.previewId, name: target.previewName, slug: target.previewSlug },
        });
    }
    throw Error(`unexpected fixture URL ${path}`);
  };
  return { bytes, zip, artifact, grant, events, state, captured, fetcher };
}
function options(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    config,
    scope,
    publisher,
    githubToken: "fixture-github",
    cloudflareToken: "fixture-cloudflare",
    oidcUrl: "https://pipelines.actions.githubusercontent.com/oidc",
    oidcRequestToken: "fixture-request",
    signal: AbortSignal.timeout(5000),
    fetcher: f.fetcher,
  };
}
const effects = (events: string[]) =>
  events.filter((e) => e.startsWith("POST https://api.cloudflare.com/"));

test("composed publisher independently verifies completed builder, journals grant, uses native multipart, persists receipt before readback", async () => {
  const f = await fixture();
  const receipt = await publishNativePreview(options(f));
  assert.equal(receipt.deploymentId, "new-deployment");
  assert.equal(effects(f.events).length, 2);
  assert.ok(
    f.events.findIndex((e) => e.endsWith("/grant")) <
      f.events.findIndex((e) => e.endsWith("assets-upload-session")),
  );
  const deployment = f.events.findIndex((e) => e.endsWith("/deployments"));
  assert.ok(f.events.slice(0, deployment).filter((e) => e.endsWith("/reauthorize")).length === 2);
  assert.equal(
    f.events.slice(deployment + 1).some((e) => e.includes("api.cloudflare.com")),
    false,
  );
  assert.deepEqual(f.captured.receipt, receipt);
  const metadata = f.captured.metadata as {
    env: Record<string, unknown>;
    bindings?: unknown;
    assets: { jwt: string; config: unknown };
  };
  assert.deepEqual(metadata.env.DATABASE_URL, { type: "inherit" });
  assert.deepEqual(metadata.env.ASSETS, { type: "assets" });
  assert.equal(metadata.bindings, undefined);
  assert.deepEqual(metadata.assets.config, { run_worker_first: true });
  assert.equal(JSON.stringify(receipt).includes("never-persist"), false);
  assert.equal(
    f.events.some((e) => /\/versions|\/routes|\/workers\/workers\/hive$/.test(e)),
    false,
  );
});

for (const flag of [
  "buildRunning",
  "buildRerun",
  "callerChanged",
  "wrongCallerRef",
  "foreignBuild",
  "wrongZipDigest",
  "grantLostAck",
  "invalidGrant",
] as const)
  test(`${flag} prevents every Cloudflare write`, async () => {
    const f = await fixture();
    f.state[flag] = true;
    await assert.rejects(publishNativePreview(options(f)));
    assert.equal(effects(f.events).length, 0);
  });
test("pause during asset transfer blocks deployment; unknown bucket blocks all following writes", async () => {
  for (const flag of ["pauseAfterAssets", "invalidBucket"] as const) {
    const f = await fixture();
    f.state[flag] = true;
    await assert.rejects(publishNativePreview(options(f)));
    assert.equal(effects(f.events).length, 1);
  }
});

test("a builder rerun starting during artifact verification cannot obtain publication authority", async () => {
  const f = await fixture();
  let latestReads = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/actions/runs/4") && ++latestReads === 2) f.state.buildRerun = true;
    return f.fetcher(url, init);
  };
  await assert.rejects(
    publishNativePreview({ ...options(f), fetcher }),
    /native_builder_unverified/,
  );
  assert.equal(latestReads, 2);
  assert.equal(effects(f.events).length, 0);
  assert.equal(
    f.events.some((event) => event.endsWith("/native-release/grant")),
    false,
  );
});
test("lost deployment ACK never constructs a receipt or retries; workflow retry cannot regain grant", async () => {
  const f = await fixture();
  f.state.lostAck = true;
  await assert.rejects(publishNativePreview(options(f)));
  assert.equal(f.captured.receipt, null);
  const written = effects(f.events).length;
  await assert.rejects(publishNativePreview(options(f)));
  assert.equal(effects(f.events).length, written);
});
test("lost receipt ACK preserves one attributed receipt and never calls provider again", async () => {
  const f = await fixture();
  f.state.receiptLostAck = true;
  await assert.rejects(publishNativePreview(options(f)));
  assert.equal(f.captured.receipt?.deploymentId, "new-deployment");
  assert.equal(effects(f.events).length, 2);
  const lastProvider = f.events.findLastIndex((e) => e.includes("api.cloudflare.com"));
  assert.ok(lastProvider < f.events.findIndex((e) => e.endsWith("/receipt")));
});
test("default-off bootstrap and foreign controller/OIDC origins fail before network", async () => {
  for (const changes of [
    { config: { ...config, bootstrapEnabled: false } },
    { config: { ...config, controllerOrigin: "https://controller.example/path" } },
    { config: { ...config, controllerOrigin: target.origin } },
    { oidcUrl: "https://evil.example/oidc" },
  ]) {
    const f = await fixture();
    await assert.rejects(publishNativePreview({ ...options(f), ...changes }));
    assert.equal(f.events.length, 0);
  }
});
test("changed archive, stale grant, and current deployment drift cannot activate", async () => {
  for (const failure of ["archive", "expired", "current"]) {
    const f = await fixture();
    if (failure === "current") f.state.current = "external-build";
    await assert.rejects(
      uploadNativePreview({
        grant: failure === "expired" ? { ...f.grant, expiresAt: Date.now() - 1 } : f.grant,
        archive: failure === "archive" ? Buffer.from("changed") : f.bytes,
        cloudflareToken: "fixture-cloudflare",
        fetcher: f.fetcher,
        signal: AbortSignal.timeout(1000),
        reauthorize: async () => {},
        persistReceipt: async () => {
          assert.fail("no receipt");
        },
      }),
    );
    assert.equal(effects(f.events).length, 0);
  }
});
test("external writer after assets is held at immediate preactivation check", async () => {
  const f = await fixture();
  let authorized = 0;
  await assert.rejects(
    uploadNativePreview({
      grant: f.grant,
      archive: f.bytes,
      cloudflareToken: "fixture-cloudflare",
      fetcher: f.fetcher,
      signal: AbortSignal.timeout(1000),
      reauthorize: async () => {
        if (++authorized === 2) f.state.current = "automatic-build";
      },
      persistReceipt: async () => assert.fail("no receipt"),
    }),
    /native_current_changed/,
  );
  assert.equal(effects(f.events).length, 1);
});
test("byte archive preserves module/asset identity and treats _headers as module", async () => {
  const f = await fixture(),
    actual = await inspectNativeArchive(f.bytes);
  assert.equal(actual.modules[0].name, "_headers");
  assert.equal(actual.assets["/_headers"], undefined);
  assert.equal(actual.assets["/index.html"].size, 5);
});

test("asset hashes match independent Wrangler 4.155.0 BLAKE3 vectors, not SHA256", () => {
  // Fixed expectations independently checked against Wrangler's blake3-wasm
  // dependency and deploy-helpers/hash.ts (base64 bytes + case-preserved extension).
  for (const [contents, name, expected] of [
    ["hello", "index.html", "a2b82584e50075886b08927390f2f573"],
    ["hello", "message.txt", "f0b3413d4cabb000327fad369003d6a5"],
    ["", "empty.bin", "869618f6a67498e0c3d5285d8322329d"],
  ])
    assert.equal(nativeAssetHash(Buffer.from(contents), name), expected);
  assert.notEqual(
    nativeAssetHash(Buffer.from("hello"), "index.html"),
    "5deeda9d2277e0ed541bfc03adafb3cf",
  );
});

test("requested asset bytes use the scoped session credential before native deployment", async () => {
  const f = await fixture();
  const hash = "a2b82584e50075886b08927390f2f573";
  let uploaded = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("assets-upload-session")) {
      assert.equal(
        String(url),
        `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/hive/assets-upload-session`,
      );
      assert.deepEqual(JSON.parse(String(init?.body)).manifest, {
        "/index.html": { hash, size: 5 },
      });
      return Response.json({
        success: true,
        result: { jwt: "scoped-assets-session", buckets: [[hash]] },
      });
    }
    if (String(url).endsWith("assets/upload?base64=true")) {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer scoped-assets-session");
      assert.ok(init?.body instanceof FormData);
      assert.equal((init.body.get(hash) as File).type, "text/html; charset=utf-8");
      assert.equal((init.body.get(hash) as File).name, hash);
      assert.equal(
        await (init.body.get(hash) as File).text(),
        Buffer.from("hello").toString("base64"),
      );
      uploaded = true;
      return Response.json({ success: true, result: { jwt: "asset-completion" } });
    }
    if (String(url).endsWith("/deployments")) assert.equal(uploaded, true);
    return f.fetcher(url, init);
  };
  await publishNativePreview({ ...options(f), fetcher });
  assert.equal(uploaded, true);
  assert.equal((f.captured.metadata?.assets as { jwt: string }).jwt, "asset-completion");
});

test("provider-selected single asset upload sends raw bytes to the exact hash route", async () => {
  const f = await fixture(),
    hash = "a2b82584e50075886b08927390f2f573";
  const session = `header.${Buffer.from(JSON.stringify({ wrangler_single_asset_uploads: true })).toString("base64url")}.signature`;
  let uploaded = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("assets-upload-session"))
      return Response.json({ success: true, result: { jwt: session, buckets: [[hash]] } });
    if (String(url).includes("/assets/upload/")) {
      assert.equal(
        String(url),
        `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/assets/upload/${hash}`,
      );
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${session}`);
      assert.equal(new Headers(init?.headers).get("Content-Type"), "text/html; charset=utf-8");
      assert.ok(init?.body instanceof Uint8Array);
      assert.equal(Buffer.from(init.body).toString(), "hello");
      uploaded = true;
      return Response.json({ success: true, result: { jwt: "completed-single" } });
    }
    assert.equal(String(url).endsWith("base64=true"), false);
    return f.fetcher(url, init);
  };
  await publishNativePreview({ ...options(f), fetcher });
  assert.equal(uploaded, true);
});

test("asset MIME matches Wrangler's text charset and unknown-type sentinel", async () => {
  const bytes = (await packReleaseArtifact(
    new Map([
      ["app/worker.js", Buffer.from("worker")],
      ["assets/file.js", Buffer.from("script")],
      ["assets/file.hiveunknownextension", Buffer.from("opaque")],
    ]),
  )) as Buffer;
  const actual = await inspectNativeArchive(bytes);
  assert.equal(
    actual.byHash.get(actual.assets["/file.js"].hash)?.contentType,
    "text/javascript; charset=utf-8",
  );
  assert.equal(
    actual.byHash.get(actual.assets["/file.hiveunknownextension"].hash)?.contentType,
    "application/null",
  );
});

test("all asset buckets are validated before any bucket is sent", async () => {
  const f = await fixture(),
    inspected = await inspectNativeArchive(f.bytes);
  const hash = inspected.assets["/index.html"].hash;
  let bucketWrites = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("assets-upload-session"))
      return Response.json({
        success: true,
        result: { jwt: "session", buckets: [[hash], ["foreign-hash"]] },
      });
    if (String(url).endsWith("base64=true")) bucketWrites++;
    return f.fetcher(url, init);
  };
  await assert.rejects(
    publishNativePreview({ ...options(f), fetcher }),
    /native_asset_bucket_invalid/,
  );
  assert.equal(bucketWrites, 0);
});

test("stalled asset response body is canceled on abort and never activates", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let canceled = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("assets-upload-session")) {
      setTimeout(() => controller.abort(), 10);
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      );
    }
    return f.fetcher(url, init);
  };
  await assert.rejects(publishNativePreview({ ...options(f), fetcher, signal: controller.signal }));
  assert.equal(canceled, true);
  assert.equal(
    f.events.some((event) => event.endsWith("/deployments")),
    false,
  );
});

test("recovery consumes the retained manifest and separate recovery action without reinserting artifact", async () => {
  const f = await fixture();
  f.grant.purpose = "recover";
  f.grant.actionId = uuid(23);
  f.grant.releaseId = uuid(22);
  const receipt = await publishNativePreview({
    ...options(f),
    scope: { ...scope, purpose: "recover", releaseId: uuid(22), actionId: uuid(23) },
  });
  assert.equal(receipt.actionId, uuid(23));
  assert.equal(
    f.events.some((event) => event.endsWith("/native-release/artifact")),
    false,
  );
  assert.equal(receipt.artifactDigest, f.artifact.artifactDigest);
});

test("recovery restores authorized retained public config when compatible current config differs", async () => {
  const f = await fixture();
  f.grant.purpose = "recover";
  f.grant.actionId = uuid(23);
  f.grant.releaseId = uuid(22);
  const current = {
    ...config,
    publicConfig: {
      ...config.publicConfig,
      vars: { ...config.publicConfig.vars, HIVE_GENERIC_TERMINAL_ENABLED: "true" },
    },
  };
  await publishNativePreview({
    ...options(f),
    config: current,
    scope: { ...scope, purpose: "recover", releaseId: uuid(22), actionId: uuid(23) },
  });
  assert.equal(
    (f.captured.metadata?.env as Record<string, unknown>).HIVE_GENERIC_TERMINAL_ENABLED,
    undefined,
  );
  assert.equal(f.captured.receipt?.publicConfigDigest, nativeDigest(config.publicConfig));
});

test("recovery still rejects a changed compatibility epoch before any provider write", async () => {
  const f = await fixture();
  f.grant.purpose = "recover";
  f.grant.actionId = uuid(23);
  f.grant.releaseId = uuid(22);
  await assert.rejects(
    publishNativePreview({
      ...options(f),
      config: { ...config, compatibilityRevision: uuid(99) },
      scope: { ...scope, purpose: "recover", releaseId: uuid(22), actionId: uuid(23) },
    }),
    /native_grant_scope_changed/,
  );
  assert.equal(effects(f.events).length, 0);
});

test("malformed provider acknowledgement remains held without annotation/readback inference", async () => {
  const f = await fixture();
  f.state.missingCreatedAt = true;
  await assert.rejects(publishNativePreview(options(f)));
  assert.equal(f.captured.receipt, null);
  assert.equal(f.events.at(-1)?.endsWith("/deployments"), true);
});
test("ZIP reader accepts bounded stored/deflate/data-descriptor artifacts and rejects tampering, links, traversal, extra entries", async () => {
  const bytes = await archive();
  for (const compressed of [false, true])
    for (const descriptor of [false, true])
      assert.deepEqual(nativeArchiveFromZip(zipArchive(bytes, compressed, descriptor)), bytes);
  for (const mutate of [
    (b: Buffer) => {
      b[b.length - 14] = 2;
    },
    (b: Buffer) => {
      b[41] ^= 1;
    },
    (b: Buffer) => {
      b.write("../evil.tar", 30);
    },
    (b: Buffer) => {
      b.writeUInt32LE(0xa1ff0000, b.length - 22 - 57 + 38);
    },
    (b: Buffer) => {
      b.writeUInt32LE(0x7fffffff, b.length - 22 - 57 + 24);
    },
  ]) {
    const damaged = zipArchive(bytes);
    mutate(damaged);
    assert.throws(() => nativeArchiveFromZip(damaged));
  }
});
test("artifact download rejects credential-leaking redirects", async () => {
  const f = await fixture();
  let calls = 0;
  await assert.rejects(
    downloadNativeArtifact({
      artifactId: "5",
      token: "fixture-github",
      signal: AbortSignal.timeout(1000),
      fetcher: async (url, init) => {
        calls++;
        if (String(url).endsWith("/zip"))
          return new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example/release.zip" },
          });
        return f.fetcher(url, init);
      },
    }),
  );
  assert.equal(calls, 2);
});
test("workflow boundaries keep candidate execution in builder and credentials in pinned publisher", async () => {
  const build = await readFile(
    new URL("../../.github/workflows/controlled-native-preview-build.yml", import.meta.url),
    "utf8",
  );
  const publish = await readFile(
    new URL("../../.github/workflows/controlled-native-preview-publish.yml", import.meta.url),
    "utf8",
  );
  assert.match(build, /id-token: none/);
  assert.doesNotMatch(build, /secrets\.|environment:/);
  assert.match(publish, /environment: hive-native-release/);
  assert.match(publish, /--ignore-scripts/);
  assert.doesNotMatch(publish, /pnpm build|wrangler|download-artifact|secrets: inherit/);
  assert.match(publish, /claims\.job_workflow_sha !== process\.env\.PUBLISHER_SHA/);
  assert.match(
    publish,
    /secrets:\n {6}HIVE_NATIVE_RELEASE_CLOUDFLARE_TOKEN:\n {8}description: [^\n]+\n {8}required: true/,
  );
  assert.match(
    publish,
    /HIVE_NATIVE_RELEASE_CONTROLLER_BEARER:\n {8}description: [^\n]+\n {8}required: false/,
  );
  assert.equal((publish.match(/HIVE_NATIVE_RELEASE_CLOUDFLARE_TOKEN:/g) ?? []).length, 2);
  const docs = await readFile(
    new URL("../../docs/controlled-native-preview-publisher.md", import.meta.url),
    "utf8",
  );
  for (const name of [
    "HIVE_NATIVE_RELEASE_CLOUDFLARE_TOKEN",
    "HIVE_NATIVE_RELEASE_CONTROLLER_BEARER",
  ])
    assert.ok(docs.includes(`${name}: \${{ secrets.${name} }}`));
});
