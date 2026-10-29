import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertBuildReady } from "../app/build-integrity.mjs";

const root = process.cwd();
const appMode = process.argv.includes("--app");
if (appMode) await assertBuildReady();
const sourcePaths = [
  "deploy/cloudflare/auth/worker.ts",
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
    next.vars = {
      ...next.vars,
      HIVE_DELIVERY_ENABLED: "true",
      HIVE_PREVIEW_ORIGIN: "http://127.0.0.1:8793",
    };
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
      result.appChecks = appChecks;
    } catch (failure) {
      result.ok = false;
      result.appChecks = appChecks;
      const message = failure instanceof Error ? failure.message : "";
      result.appFailure =
        /^(Actual app|Authenticated app|App owner|Cross-site app|Revoked app|Local synthetic)/.test(
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
  const evidencePath = `docs/checks/autonomous-delivery/cloudflare-auth-${appMode ? "app" : "local"}.json`;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", evidencePath], { stdio: "ignore" });
  console.log(JSON.stringify({ httpStatus: response.status, ...result }));
  if (!response.ok || !result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local auth proof failed");
  process.exitCode = 1;
} finally {
  await writeFile("/tmp/hive-auth-workerd-private.log", logs, { mode: 0o600 });
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  await rm(privateDirectory, { recursive: true, force: true });
}
