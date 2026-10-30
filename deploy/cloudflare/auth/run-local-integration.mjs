import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertBuildReady } from "../app/build-integrity.mjs";

const root = process.cwd();
const appMode = process.argv.includes("--app");
const callbacks = process.argv.includes("--callbacks");
const deliveryCallbacks = process.argv.includes("--delivery-callbacks");
if (callbacks && !appMode) throw new Error("Callback proof requires actual app mode");
if (deliveryCallbacks && !callbacks) throw new Error("Delivery callback proof requires callbacks");
const deliveryCallbackPaths = [
  "/api/codex-host/guardians",
  "/api/delivery/host",
  "/api/delivery/native",
  "/api/delivery/github-source/challenge",
  "/api/delivery/github-source",
  "/api/delivery/source-publication/policy",
  "/api/delivery/source-publication/challenge",
  "/api/delivery/source-publication",
  "/api/delivery/source-publication/state",
];
const callbackIssuer = callbacks ? generateKeyPairSync("ed25519") : null;
if (appMode) await assertBuildReady();
const sourcePaths = [
  "deploy/cloudflare/auth/worker.ts",
  "deploy/cloudflare/auth/local-callback-app.worker.ts",
  "deploy/cloudflare/auth/local-integration.worker.ts",
  "deploy/cloudflare/auth/run-local-integration.mjs",
  "deploy/cloudflare/app/request-lifetime.ts",
  "services/auth/src/fetch-handler.ts",
  "services/auth/src/auth/domain.ts",
  "services/auth/src/auth/login.ts",
  "services/auth/src/auth/credential-store.ts",
  "services/auth/src/auth/managed-keys.ts",
  "services/auth/src/auth/token-rotation.ts",
  "services/auth/src/auth/session.ts",
  "services/auth/src/auth/token-status.ts",
  "packages/auth/src/client.ts",
  "packages/auth/src/encryption.ts",
  "packages/auth/src/cookie.ts",
  "packages/db/prisma/schema.prisma",
  "packages/db/src/cloudflare.ts",
  "packages/db/src/workerd.ts",
  "packages/db/src/request-scope.ts",
  "packages/db/src/generated/prisma-workerd/client.ts",
  "packages/db/src/generated/prisma-workerd/internal/class.ts",
  "packages/db/package.json",
  "next.config.ts",
  "src/lib/auth/service-client.ts",
  "deploy/cloudflare/app/worker.ts",
  "deploy/cloudflare/app/host-callback.ts",
  "src/lib/codex-session/host-callback-transport.ts",
  "src/proxy.ts",
  "src/lib/codex-session/route.server.ts",
  "src/lib/codex-session/registered-session.server.ts",
  "src/lib/codex-session/registration.server.ts",
  "src/lib/delivery/reads.ts",
];
async function sourceDigests() {
  const sources = {};
  for (const path of sourcePaths)
    sources[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  return sources;
}
const sources = await sourceDigests();
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const testedSourceCommitted = !execFileSync(
  "git",
  ["status", "--porcelain", "--", ...sourcePaths],
  { encoding: "utf8" },
).trim();
const privateDirectory = await mkdtemp(join(tmpdir(), "hive-auth-workerd-"));
const runtimeUrl = (
  await readFile("/tmp/hive-epic-coder-auth/neon-app-preview-runtime-url", "utf8")
).trim();
const database = new URL(runtimeUrl);
if (database.username !== "hive_app_runtime" || database.pathname !== "/hive_app_preview")
  throw new Error("Isolated least-privilege app database is required");
const bearer = randomBytes(32).toString("hex");
const previewBearer = randomBytes(32).toString("hex");
const runId = randomUUID();
const config = {
  name: "hive-auth-local-proof",
  main: resolve("deploy/cloudflare/auth/local-integration.worker.ts"),
  compatibility_date: "2026-10-29",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  workers_dev: false,
  preview_urls: false,
  vars: { HIVE_RUNTIME_TARGET: "cloudflare", CODER_URL: "https://coder.kethalia.com" },
  ...(appMode ? { services: [{ binding: "APP", service: "hive-app-compatibility-preview" }] } : {}),
};
await writeFile(join(privateDirectory, "wrangler.json"), JSON.stringify(config), { mode: 0o600 });
const extraConfigs = [];
if (appMode) {
  for (const service of ["app", "auth"]) {
    const next = JSON.parse(await readFile(`deploy/cloudflare/${service}/wrangler.jsonc`, "utf8"));
    delete next.$schema;
    next.main = resolve(`deploy/cloudflare/${service}/worker.ts`);
    if (callbacks && service === "app")
      next.main = resolve("deploy/cloudflare/auth/local-callback-app.worker.ts");
    next.vars = {
      ...next.vars,
      HIVE_DELIVERY_ENABLED: "true",
      HIVE_PREVIEW_ORIGIN: "http://127.0.0.1:8793",
      ...(callbacks
        ? {
            HIVE_CODEX_GATEWAY_ENABLED: "true",
            HIVE_CODEX_ISSUER_KEY_ID: "local-proof-issuer",
            HIVE_CODEX_HIVE_ORIGIN: "https://local-callback-proof.invalid",
            HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: "local-software",
            HIVE_CODEX_APP_SLUG: "codex-session",
            HIVE_CODEX_GATEWAY_PORT: "13341",
            HIVE_CODEX_SESSION_TRANSPORT: "relay",
          }
        : {}),
      ...(deliveryCallbacks && service === "app"
        ? {
            HIVE_GUARDIAN_ENABLED: "true",
            HIVE_DELIVERY_MANAGER_ENABLED: "true",
            HIVE_DELIVERY_NATIVE_ENABLED: "true",
            HIVE_DELIVERY_GITHUB_SOURCE_ENABLED: "true",
            HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED: "true",
            // Constructor-only fixture pins. No host is enrolled or authorized.
            HIVE_GUARDIAN_APPROVED_PACKAGES_JSON: JSON.stringify([
              {
                packageManifestSha256: "1".repeat(64),
                guardianElfSha256: "2".repeat(64),
                nodeSha256: "3".repeat(64),
                protocol: "guardian-v1",
                policyDigest: "4".repeat(64),
                metadataPolicyDigest:
                  "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
              },
            ]),
          }
        : {}),
    };
    if (deliveryCallbacks && service === "app")
      next.r2_buckets = [
        {
          binding: "HIVE_DELIVERY_EVIDENCE",
          bucket_name: "hive-local-callback-proof",
          remote: false,
        },
      ];
    if (next.assets) next.assets.directory = resolve(".open-next/assets");
    const path = join(privateDirectory, `${service}.json`);
    await writeFile(path, JSON.stringify(next), { mode: 0o600 });
    extraConfigs.push("--config", path);
  }
}
await writeFile(
  join(privateDirectory, ".dev.vars"),
  Object.entries({
    DATABASE_URL: runtimeUrl,
    AUTH_SERVICE_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    COOKIE_SECRET: randomBytes(32).toString("hex"),
    PROOF_BEARER: bearer,
    PREVIEW_BEARER: previewBearer,
    PREVIEW_COOKIE_SECRET: randomBytes(32).toString("hex"),
    RUN_UUID: runId,
    ...(callbackIssuer
      ? {
          HIVE_CODEX_ISSUER_PRIVATE_KEY: callbackIssuer.privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        }
      : {}),
  })
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n"),
  { mode: 0o600 },
);
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    join(privateDirectory, "wrangler.json"),
    ...extraConfigs,
    "--ip",
    "127.0.0.1",
    "--port",
    "8793",
    "--inspector-port",
    "0",
  ],
  {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let logs = "";
child.stdout.on("data", (chunk) => {
  logs += chunk;
});
child.stderr.on("data", (chunk) => {
  logs += chunk;
});
try {
  const deadline = Date.now() + 60000;
  while (!logs.includes("Ready on")) {
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error("Local auth workerd did not become ready; private runtime log retained");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const response = await fetch("http://127.0.0.1:8793/__local-auth-proof", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (appMode && result.ok) {
    const request = (path, init = {}) =>
      fetch(`http://127.0.0.1:8793${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    const control = (path) =>
      request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}` },
      });
    const appChecks = {};
    try {
      const seed = await control("/__local-auth-seed");
      if (!seed.ok) throw new Error("Local synthetic app fixture setup failed");
      const { cookie, taskId } = await seed.json();
      const headers = {
        Cookie: cookie,
        "sec-fetch-site": "same-origin",
        Authorization: `Bearer ${previewBearer}`,
      };
      const unauthenticated = await request("/login");
      if (unauthenticated.status !== 401) throw new Error("Actual app preview guard failed");
      appChecks.privatePreviewGuardBeforeFramework = true;
      const privateAsset = "/icons/hive-mark.svg";
      if ((await request(privateAsset)).status !== 401)
        throw new Error("Actual app preview static asset guard failed");
      const authorizedAsset = await request(privateAsset, { headers });
      if (
        authorizedAsset.status !== 200 ||
        !authorizedAsset.headers.get("cache-control")?.includes("no-store")
      )
        throw new Error("Actual app preview asset privacy failed");
      await authorizedAsset.arrayBuffer();
      appChecks.privateStaticAssetsGuardAndNoStore = true;
      const bootstrapped = await request("/__hive-preview/access", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:8793", Authorization: `Bearer ${previewBearer}` },
      });
      const previewCookie = bootstrapped.headers.get("set-cookie")?.split(";")[0];
      if (bootstrapped.status !== 204 || !previewCookie)
        throw new Error("Actual app preview cookie bootstrap failed");
      const cookieAsset = await request(privateAsset, { headers: { Cookie: previewCookie } });
      if (cookieAsset.status !== 200) throw new Error("Actual app preview cookie asset failed");
      await cookieAsset.arrayBuffer();
      appChecks.privatePreviewCookieBootstrapAndAsset = true;
      const list = await request("/api/delivery/tasks", { headers });
      const payload = await list.json();
      if (list.status !== 200 || payload.tasks?.length !== 1 || payload.tasks[0].id !== taskId)
        throw new Error("Actual app task list failed");
      appChecks.authenticatedAppListThroughServiceBinding = true;
      const detail = await request(`/api/delivery/tasks/${taskId}`, { headers });
      if (detail.status !== 200 || (await detail.json()).id !== taskId)
        throw new Error("Actual app task detail failed");
      appChecks.authenticatedAppDetailThroughServiceBinding = true;
      if (
        !list.headers.get("cache-control")?.includes("no-store") ||
        !list.headers.get("content-security-policy")
      )
        throw new Error("Authenticated app response protections missing");
      appChecks.authenticatedMiddlewareCSPAndPrivateCache = true;
      if ((await request(`/api/delivery/tasks/${randomUUID()}`, { headers })).status !== 404)
        throw new Error("App owner read boundary failed");
      appChecks.foreignOrMissingTaskRejected = true;
      if (
        (
          await request("/api/delivery/tasks", {
            headers: { ...headers, "sec-fetch-site": "cross-site" },
          })
        ).status !== 403
      )
        throw new Error("Cross-site app read accepted");
      appChecks.crossSiteReadRejected = true;
      const logout = await request("/api/auth/logout", { method: "POST", headers });
      if (logout.status !== 200) throw new Error("Actual app logout failed");
      const revoked = await request("/api/delivery/tasks", { headers });
      if (![307, 401].includes(revoked.status)) throw new Error("Revoked app cookie accepted");
      appChecks.actualAppLogoutAndRevokedCookieRejected = true;
      if (callbacks) {
        const configured = await request("/__local-callback-configuration", {
          headers: { Authorization: `Bearer ${bearer}` },
        });
        const expectedPublic = createHash("sha256")
          .update(callbackIssuer.publicKey.export({ type: "spki", format: "der" }))
          .digest("hex");
        if (
          configured.status !== 200 ||
          (await configured.json()).issuerPublicKeySHA256 !== expectedPublic
        )
          throw new Error("Native registration transport issuer configuration invalid");
        appChecks.nativeCallbackIssuerConfigurationVerified = true;
        const forged = generateKeyPairSync("ed25519");
        const head = Buffer.from(
            JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "local-proof-issuer" }),
          ).toString("base64url"),
          payload = Buffer.from("{}").toString("base64url");
        const grant = `${head}.${payload}.${sign(null, Buffer.from(`${head}.${payload}`), forged.privateKey).toString("base64url")}`;
        const callbackHeaders = { "Content-Type": "application/json" };
        const rejected = await request("/api/codex-host/registrations", {
          method: "POST",
          headers: callbackHeaders,
          body: JSON.stringify({
            grant,
            serverInstanceId: "local-instance",
            protocolVersion: "0.165.0",
            threads: [],
            hostPublicKeyPem: forged.publicKey.export({ type: "spki", format: "pem" }).toString(),
            proof: "a".repeat(86),
          }),
        });
        if (rejected.status !== 403 || (await rejected.json()).error !== "registration_rejected")
          throw new Error("Native registration transport did not enforce issuer signature");
        appChecks.nativeRegistrationTransportRejectsForgedIssuer = true;
        const registrationId = randomUUID();
        const heartbeat = await request(
          `/api/codex-host/registrations/${registrationId}/heartbeat`,
          {
            method: "POST",
            headers: callbackHeaders,
            body: JSON.stringify({
              registrationId,
              serverInstanceId: "local-instance",
              sequence: 1,
              nonce: randomUUID(),
              proof: "a".repeat(86),
            }),
          },
        );
        if (heartbeat.status !== 403 || (await heartbeat.json()).error !== "registration_rejected")
          throw new Error("Native heartbeat transport did not enforce registered authority");
        appChecks.nativeHeartbeatRejectsUnknownRegistration = true;
        for (const path of deliveryCallbackPaths) {
          const invalid = await request(path, {
            method: "POST",
            headers: callbackHeaders,
            body: "{}",
          });
          const expectedStatus = deliveryCallbacks ? 400 : 401;
          if (invalid.status !== expectedStatus)
            throw new Error(
              `Native delivery callback ${path} returned ${invalid.status}; expected ${expectedStatus}`,
            );
          if (deliveryCallbacks && (await invalid.json()).error !== "invalid_request")
            throw new Error(`Native delivery callback ${path} did not reject the invalid envelope`);
          await invalid.body?.cancel().catch(() => {});
          for (const suffix of ["?invalid=1", "/extra"]) {
            const ordinary = await request(path + suffix, {
              method: "POST",
              headers: callbackHeaders,
              body: "{}",
            });
            if (ordinary.status !== 401)
              throw new Error("Callback exception widened the private gate");
            await ordinary.body?.cancel();
          }
        }
        appChecks.deliveryCallbackTransport = deliveryCallbacks
          ? "nine enabled routes reject malformed envelopes; no host authority established"
          : "all nine disabled routes retain the private preview gate";
        for (const [path, init] of [
          ["/api/codex-host/registrations", { method: "GET" }],
          [
            "/api/codex-host/%72egistrations",
            { method: "POST", headers: callbackHeaders, body: "{}" },
          ],
          [
            "/api/codex-host/registrations?invalid=1",
            { method: "POST", headers: callbackHeaders, body: "{}" },
          ],
          ["/api/projects", { method: "POST", headers: callbackHeaders, body: "{}" }],
        ]) {
          const ordinary = await request(path, init);
          if (ordinary.status !== 401)
            throw new Error("Callback exception widened the private gate");
          await ordinary.body?.cancel();
        }
        appChecks.nativeCallbackExceptionRemainsExactAndPrivate = true;
      }
      result.appChecks = appChecks;
    } catch (failure) {
      result.ok = false;
      result.appChecks = appChecks;
      const message = failure instanceof Error ? failure.message : "";
      result.appFailure =
        /^(Actual app|Authenticated app|App owner|Cross-site app|Revoked app|Local synthetic|Native registration transport|Native heartbeat transport|Native delivery callback|Callback exception)/.test(
          message,
        )
          ? message
          : "Unexpected local app response";
    } finally {
      const cleaned = await control("/__local-auth-cleanup").catch(() => null);
      if (!cleaned?.ok) {
        result.ok = false;
        result.appFailure = "Local synthetic app fixture cleanup failed";
      }
    }
  }
  const sourceStable =
    JSON.stringify(sources) === JSON.stringify(await sourceDigests()) &&
    testedRevision === execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!sourceStable) {
    result.ok = false;
    result.sourceChangedDuringProof = true;
  }
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    scope:
      "actual full-schema Prisma6 + auth Worker/domain and task read functions in local workerd, isolated Neon synthetic fixtures only",
    testedRevision,
    testedSourceCommitted,
    sourceStable,
    runId,
    httpStatus: response.status,
    result,
    sourceDigests: sources,
    coderLoginPerformed: false,
    serviceBindingTransportVerified: Boolean(
      result.appChecks?.actualAppLogoutAndRevokedCookieRejected,
    ),
    credentialRotationControllerVerified: false,
    cloudDeployed: false,
    ...(appMode
      ? {
          appBuildReadySHA256: createHash("sha256")
            .update(await readFile(".open-next/hive-build-ready.json"))
            .digest("hex"),
        }
      : {}),
  };
  const evidencePath = `docs/checks/autonomous-delivery/cloudflare-auth-${deliveryCallbacks ? "delivery-callbacks" : appMode ? "app" : "local"}.json`;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", evidencePath], { stdio: "ignore" });
  console.log(JSON.stringify({ httpStatus: response.status, ...result }));
  if (!response.ok || !result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local auth proof failed");
  process.exitCode = 1;
} finally {
  await writeFile("/tmp/hive-auth-workerd-private.log", logs, { mode: 0o600 });
  const running = () => child.exitCode === null && child.signalCode === null;
  const waitForExit = async () => {
    if (!running()) return;
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  };
  // Never signal a numeric process group after its leader has been reaped.
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!running()) break;
    try {
      process.kill(-child.pid, signal);
    } catch {}
    await waitForExit();
  }
  let groupGone = false;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    groupGone = error.code === "ESRCH";
  }
  if (!running() && groupGone) await rm(privateDirectory, { recursive: true, force: true });
  else {
    // A surviving descendant or unknown identity is not permission to signal
    // a possibly reused group or remove its private runtime configuration.
    console.error("Local runtime shutdown uncertain; private fixture retained for inspection");
    process.exitCode = 1;
  }
}
