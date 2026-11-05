import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { uploadReleaseVersion } from "./cloudflare-upload.mjs";

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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[1-9][0-9]{0,19}$/;
const sha = /^[a-f0-9]{40}$/;
const hex = /^[a-f0-9]{64}$/;
async function json(fetcher, url, init, signal) {
  const response = await fetcher(url, { ...init, signal, redirect: "error" });
  if (!response.ok || !response.body) throw Error("publisher_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw Error("publisher_aborted");
      const { done, value } = await reader.read();
      if (signal.aborted) throw Error("publisher_aborted");
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw Error("publisher_limit");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// All config comes from the protected deployment environment. No candidate
// bundle or workflow input can select a target, metadata, controller or token.
export async function publishRelease({
  config,
  identity,
  archive,
  oidcUrl,
  oidcRequestToken,
  cloudflareToken,
  previewBearer,
  fetcher = fetch,
  signal,
}) {
  if (
    !config ||
    !identity ||
    !signal ||
    signal.aborted ||
    !Buffer.isBuffer(archive) ||
    archive.length > 128 * 1024 * 1024 ||
    !id.test(identity.repositoryId) ||
    !id.test(identity.repositoryOwnerId) ||
    !id.test(identity.runId) ||
    !Number.isSafeInteger(identity.runAttempt) ||
    identity.runAttempt < 1 ||
    !sha.test(identity.mergeSha)
  )
    throw Error("publisher_scope");
  const origin = new URL(config.controllerOrigin),
    oidc = new URL(oidcUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    oidc.protocol !== "https:" ||
    !oidc.hostname.endsWith(".actions.githubusercontent.com") ||
    oidc.username ||
    oidc.password ||
    oidc.hash ||
    !/^urn:hive:release-build:[a-z0-9_-]{1,48}:$/.test(config.audiencePrefix) ||
    !oidcRequestToken ||
    /[\r\n]/.test(oidcRequestToken) ||
    !cloudflareToken ||
    (previewBearer !== undefined && !/^[a-f0-9]{64}$/.test(previewBearer)) ||
    !hex.test(config.targetDigest) ||
    digest(config.target) !== config.targetDigest ||
    !config.components
  )
    throw Error("publisher_config");
  const token = async (value) => {
    const url = new URL(oidc);
    url.searchParams.set("audience", `${config.audiencePrefix}${digest(value)}`);
    const result = await json(
      fetcher,
      url.toString(),
      { method: "GET", headers: { Authorization: `Bearer ${oidcRequestToken}` } },
      signal,
    );
    if (
      typeof result.value !== "string" ||
      !result.value ||
      result.value.length > 16384 ||
      /[\r\n]/.test(result.value)
    )
      throw Error("publisher_oidc");
    return result.value;
  };
  const post = (path, body, bearer) =>
    json(
      fetcher,
      new URL(path, origin).toString(),
      {
        method: "POST",
        headers: {
          ...(previewBearer ? { Authorization: `Bearer ${previewBearer}` } : {}),
          "X-Hive-Release-OIDC": bearer,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      signal,
    );
  const challenge = {
    schemaVersion: 1,
    purpose: "release_build_challenge",
    ...identity,
    targetDigest: config.targetDigest,
    publisherConfigDigest: digest(config),
  };
  const scope = await post(
    "/api/internal/release-build/challenge",
    challenge,
    await token(challenge),
  );
  if (
    !uuid.test(scope.releaseId) ||
    !uuid.test(scope.ownerId) ||
    scope.targetDigest !== config.targetDigest ||
    scope.publisherConfigDigest !== digest(config) ||
    scope.mergeSha !== identity.mergeSha
  )
    throw Error("publisher_challenge_scope");
  const results = {};
  for (const component of ["app", "auth"]) {
    const componentConfig = config.components[component];
    if (!componentConfig || !hex.test(componentConfig.expectedConfigDigest))
      throw Error("publisher_config");
    results[component] = await uploadReleaseVersion({
      archive,
      component,
      accountId: config.target.accountId,
      script: config.target.scripts[component],
      metadata: componentConfig.metadata,
      expectedConfigDigest: componentConfig.expectedConfigDigest,
      sourceSha: identity.mergeSha,
      apiToken: cloudflareToken,
      fetcher,
      signal,
    });
  }
  const manifest = {
    schemaVersion: 1,
    releaseId: scope.releaseId,
    ownerId: scope.ownerId,
    ...identity,
    targetDigest: config.targetDigest,
    app: results.app,
    auth: results.auth,
  };
  const receipt = await post(
    "/api/internal/release-build/attestation",
    manifest,
    await token(manifest),
  );
  if (receipt.releaseId !== scope.releaseId || receipt.manifestDigest !== digest(manifest))
    throw Error("publisher_receipt_scope");
  return receipt;
}

async function main() {
  if (process.env.HIVE_RELEASE_UPLOAD_ENABLED !== "true") throw Error("publisher_disabled");
  const configText = process.env.HIVE_RELEASE_UPLOAD_CONFIG_JSON;
  if (!configText || Buffer.byteLength(configText) > 65536) throw Error("publisher_config");
  const file = await open("artifact/release.tar", constants.O_RDONLY | constants.O_NOFOLLOW);
  let archive;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 128 * 1024 * 1024)
      throw Error("publisher_limit");
    archive = await file.readFile();
  } finally {
    await file.close();
  }
  const receipt = await publishRelease({
    config: JSON.parse(configText),
    identity: {
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
      mergeSha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    },
    archive,
    oidcUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    oidcRequestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    cloudflareToken: process.env.HIVE_RELEASE_CLOUDFLARE_UPLOAD_TOKEN,
    previewBearer: process.env.HIVE_RELEASE_PREVIEW_BEARER || undefined,
    signal: AbortSignal.timeout(240000),
  });
  process.stdout.write(`Release build submitted: ${receipt.releaseId} ${receipt.manifestDigest}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write("Release publisher held; consult trusted controller logs.\n");
    process.exitCode = 1;
  });
