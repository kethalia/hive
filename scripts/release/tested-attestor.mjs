import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
const sha = /^[a-f0-9]{40}$/;
const hex = /^[a-f0-9]{64}$/;
const id = /^[1-9][0-9]{0,19}$/;
async function json(fetcher, url, init, signal) {
  const response = await fetcher(url, { ...init, signal, redirect: "error" });
  if (!response.ok || !response.body) throw Error("tested_attestor_unavailable");
  const reader = response.body.getReader(),
    parts = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw Error("tested_attestor_aborted");
      const x = await reader.read();
      if (x.done) break;
      bytes += x.value.length;
      if (bytes > 32768) {
        await reader.cancel();
        throw Error("tested_attestor_limit");
      }
      parts.push(x.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
/** Only the reviewed isolated attestor job calls this. Candidate code never
 * receives its OIDC request token, preview bearer, or this process environment. */
export async function attestTestedTree({
  config,
  identity,
  oidcUrl,
  oidcToken,
  previewBearer,
  fetcher = fetch,
  signal,
}) {
  if (
    !signal ||
    signal.aborted ||
    !config ||
    !identity ||
    !sha.test(identity.headSha) ||
    !sha.test(identity.baseSha) ||
    !sha.test(identity.mergeSha) ||
    !sha.test(identity.treeSha) ||
    !id.test(identity.repositoryId) ||
    !id.test(identity.repositoryOwnerId) ||
    !id.test(identity.runId) ||
    !Number.isSafeInteger(identity.pullNumber) ||
    identity.pullNumber < 1 ||
    !Number.isSafeInteger(identity.runAttempt) ||
    identity.runAttempt < 1 ||
    !hex.test(config.controlDigest) ||
    !/^urn:hive:release-tested:[a-z0-9_-]{1,48}:$/.test(config.audiencePrefix)
  )
    throw Error("tested_attestor_scope");
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
    !oidcToken ||
    /[\r\n]/.test(oidcToken) ||
    (previewBearer !== undefined &&
      (typeof previewBearer !== "string" ||
        previewBearer.length > 4096 ||
        /[\r\n]/.test(previewBearer)))
  )
    throw Error("tested_attestor_scope");
  const request = {
    schemaVersion: 1,
    purpose: "release_test_challenge",
    ...identity,
    controlDigest: config.controlDigest,
  };
  async function send(path, body) {
    const audience = config.audiencePrefix + digest(body),
      tokenUrl = new URL(oidc);
    tokenUrl.searchParams.set("audience", audience);
    const jwt = await json(
      fetcher,
      tokenUrl,
      { headers: { Authorization: `Bearer ${oidcToken}` } },
      signal,
    );
    if (
      typeof jwt.value !== "string" ||
      jwt.value.length > 16384 ||
      !/^[A-Za-z0-9_.-]+$/.test(jwt.value)
    )
      throw Error("tested_attestor_token");
    return json(
      fetcher,
      new URL(path, origin),
      {
        method: "POST",
        headers: {
          ...(previewBearer ? { Authorization: `Bearer ${previewBearer}` } : {}),
          "X-Hive-Release-OIDC": jwt.value,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      signal,
    );
  }
  const result = await send("/api/internal/release-tested/challenge", request);
  if (
    !result ||
    typeof result.challengeId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(result.challengeId) ||
    !hex.test(result.nonce) ||
    !hex.test(result.policyDigest) ||
    !hex.test(result.checksDigest)
  )
    throw Error("tested_attestor_challenge");
  const { purpose: _, ...scope } = request;
  return send("/api/internal/release-tested/attestation", {
    ...scope,
    purpose: "release_test_attestation",
    challengeId: result.challengeId,
    nonce: result.nonce,
    policyDigest: result.policyDigest,
    checksDigest: result.checksDigest,
  });
}
export function assertManagedTestSource(event, repository, baseBranch) {
  const pull = event?.pull_request;
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  if (
    !baseBranch ||
    pull?.base?.ref !== baseBranch ||
    pull?.head?.repo?.full_name !== repository ||
    pull?.base?.repo?.full_name !== repository ||
    !new RegExp(`^codex/delivery/${uuid}/${uuid}$`).test(pull?.head?.ref ?? "")
  )
    throw Error("tested_attestor_source");
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (process.env.HIVE_TESTED_MANAGED_SOURCE_BASE) {
    if (process.env.GITHUB_EVENT_NAME !== "pull_request") throw Error("tested_attestor_source");
    assertManagedTestSource(
      event,
      process.env.GITHUB_REPOSITORY,
      process.env.HIVE_TESTED_MANAGED_SOURCE_BASE,
    );
  }
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: process.env.HIVE_TESTED_CANDIDATE_DIR,
      encoding: "utf8",
      timeout: 10000,
    }).trim();
  const mergeSha = git("rev-parse", "HEAD"),
    treeSha = git("rev-parse", "HEAD^{tree}"),
    parents = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  if (
    parents.length !== 3 ||
    mergeSha !== process.env.GITHUB_SHA ||
    parents[1] !== event.pull_request.base.sha ||
    parents[2] !== event.pull_request.head.sha
  )
    throw Error("tested_attestor_merge");
  const identity = {
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
    pullNumber: event.number,
    headSha: parents[2],
    baseSha: parents[1],
    mergeSha,
    treeSha,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  await attestTestedTree({
    config: JSON.parse(process.env.HIVE_RELEASE_TESTED_CONFIG_JSON),
    identity,
    oidcUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    oidcToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    previewBearer: process.env.HIVE_RELEASE_PREVIEW_BEARER,
    signal: AbortSignal.timeout(30000),
  });
}
