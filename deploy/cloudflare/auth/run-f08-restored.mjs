// Local rehearsal only. Explicit reviewed opt-in is required; no deployed route imports this.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { artifactDigest, readReleaseArtifact } from "../../../scripts/release/artifact.mjs";
import { cleanupF08User, setupF08Role, verifyF08Role } from "./f08-restored-role.mjs";

const required = (v) => {
  if (!v) throw Error("f08_configuration_unavailable");
  return v;
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const secret = () => randomBytes(32).toString("hex");
async function port() {
  const s = createServer();
  await new Promise((ok, fail) => {
    s.once("error", fail);
    s.listen(0, "127.0.0.1", ok);
  });
  const p = s.address().port;
  await new Promise((ok, fail) => s.close((e) => (e ? fail(e) : ok())));
  return p;
}
async function ready(child) {
  return new Promise((ok, fail) => {
    let text = "";
    const timer = setTimeout(() => finish(Error("f08_worker_timeout")), 60000);
    const finish = (e) => {
      clearTimeout(timer);
      child.off("exit", exit);
      child.stdout.off("data", data);
      child.stderr.off("data", data);
      e ? fail(e) : ok();
    };
    const exit = () => finish(Error("f08_worker_exited"));
    const data = (chunk) => {
      text += chunk.toString();
      if (text.length > 65536) text = text.slice(-65536);
      if (text.includes("Ready on")) finish();
    };
    child.once("exit", exit);
    child.stdout.on("data", data);
    child.stderr.on("data", data);
  });
}
function fingerprint(ownerFile, captureFile, dumpFile, fixtureId) {
  const args = [
    "-B",
    "deploy/cloudflare/auth/f08-restored-fingerprint.py",
    ownerFile,
    captureFile,
    dumpFile,
    ...(fixtureId ? [fixtureId] : []),
  ];
  const value = JSON.parse(
    execFileSync("python3", args, {
      encoding: "utf8",
      timeout: 100000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (Object.keys(value).length !== 8 || Object.values(value).some((v) => !v.matches))
    throw Error("f08_original_fingerprint_changed");
  return value;
}
if (process.env.HIVE_F08_EXECUTE_REVIEWED !== "true")
  throw Error("f08_reviewed_execution_required");
const root = process.cwd(),
  ownerFile = required(process.env.HIVE_F08_OWNER_FILE),
  captureFile = required(process.env.HIVE_F08_CAPTURE_FILE),
  dumpFile = required(process.env.HIVE_F08_DUMP_FILE),
  archiveFile = required(process.env.HIVE_F08_ARCHIVE_FILE);
const bytes = await readFile(archiveFile);
if (sha(bytes) !== "ee863255e31a43d85a491d80fed83a4a42bf4b60869a145219c9d2e792376a12")
  throw Error("f08_archive_changed");
const files = await readReleaseArtifact(bytes),
  appDigest = artifactDigest(files, "app"),
  authDigest = artifactDigest(files, "auth");
if (
  appDigest !== "fb9abdf4d96706440a6e2037a3eaa5bc2bf1fe9b5f511d75fd374ef49a15995a" ||
  authDigest !== "583617f1bcd4569a43079fe0b8e14b7f70cbdcda960ef97ef3a4b75c73e1d73a"
)
  throw Error("f08_artifact_changed");
const _baseline = fingerprint(ownerFile, captureFile, dumpFile);
const requestedState = process.env.HIVE_F08_EXISTING_PRIVATE_DIR;
const directory = requestedState
  ? await realpath(requestedState)
  : await mkdtemp(join(tmpdir(), "hive-f08-restored-"));
if (
  !/^\/tmp\/hive-f08-restored-[A-Za-z0-9]+$/.test(directory) ||
  (requestedState && directory !== requestedState)
)
  throw Error("f08_private_state_scope");
const directoryStat = await stat(directory);
if (directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077) !== 0)
  throw Error("f08_private_state_permissions");
const existing = requestedState
  ? JSON.parse(await readFile(join(directory, "role-checkpoint.json"), "utf8"))
  : null;
const fixtureId = existing?.fixtureId ?? randomUUID(),
  validSession = randomUUID(),
  expiredSession = randomUUID();
const runtimeFile = join(directory, "runtime-url"),
  checkpointFile = join(directory, "role-checkpoint.json"),
  children = [];
const bearer = secret(),
  authSecret = secret(),
  encryption = secret(),
  badEncryption = secret(),
  cookieSecret = secret(),
  preview = secret(),
  syntheticToken = `f08-${randomUUID()}`;
let seeded = false,
  role,
  cleanupSucceeded = false,
  ports;
try {
  role = existing
    ? { role: existing.role, fixtureId: existing.fixtureId }
    : await setupF08Role({ ownerFile, runtimeFile, checkpointFile, fixtureId });
  await verifyF08Role({ runtimeFile, fixtureId });
  const runtimeUrl = (await readFile(runtimeFile, "utf8")).trim(),
    u = new URL(runtimeUrl);
  if (u.pathname !== "/hive_production_rehearsal_20261105" || u.username !== role.role)
    throw Error("f08_runtime_scope");
  ports = [await port(), await port()];
  if (ports[0] === ports[1]) throw Error("f08_port_collision");
  for (const [index, workerPort] of ports.entries()) {
    const base = join(directory, String(index));
    for (const [name, data] of files) {
      const path = join(base, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, { mode: 0o600 });
    }
    await mkdir(join(base, "assets"), { recursive: true });
    const suffix = fixtureId.replaceAll("-", "") + index,
      appName = `hive-f08-app-${suffix}`,
      authName = `hive-f08-auth-${suffix}`;
    const common = {
      compatibility_date: "2026-10-29",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      workers_dev: false,
      preview_urls: false,
    };
    const vars = {
      HIVE_RUNTIME_TARGET: "cloudflare",
      HIVE_DELIVERY_ENABLED: "true",
      HIVE_DISABLE_BACKGROUND_WORKERS: "true",
      HIVE_PROJECT_TASKS_ENABLED: "false",
      HIVE_TOKEN_ROTATION_ENABLED: "false",
      CODER_URL: "https://coder.invalid",
      HIVE_PREVIEW_ORIGIN: `http://127.0.0.1:${workerPort}`,
    };
    const front = {
      ...common,
      name: `hive-f08-front-${suffix}`,
      main: resolve("deploy/cloudflare/auth/f08-restored-fixture.worker.ts"),
      services: [
        { binding: "APP", service: appName },
        { binding: "AUTH_SERVICE", service: authName },
      ],
    };
    const app = {
      ...common,
      name: appName,
      main: join(base, "app/worker.js"),
      no_bundle: true,
      vars,
      services: [{ binding: "AUTH_SERVICE", service: authName }],
      assets: { directory: join(base, "assets"), binding: "ASSETS", run_worker_first: true },
    };
    const auth = {
      ...common,
      name: authName,
      main: join(base, "auth/worker.js"),
      no_bundle: true,
      vars,
    };
    const paths = ["front", "app", "auth"].map((n) => join(base, `${n}.json`));
    for (const [i, value] of [front, app, auth].entries())
      await writeFile(paths[i], JSON.stringify(value), { mode: 0o600 });
    const secrets = {
      DATABASE_URL: runtimeUrl,
      AUTH_SERVICE_SECRET: authSecret,
      ENCRYPTION_KEY: index ? badEncryption : encryption,
      COOKIE_SECRET: cookieSecret,
      F08_BEARER: bearer,
      F08_RUN_ID: fixtureId,
      F08_VALID_SESSION: validSession,
      F08_EXPIRED_SESSION: expiredSession,
      F08_SYNTHETIC_TOKEN: syntheticToken,
      F08_WRONG_KEY: index ? "true" : "false",
      PREVIEW_BEARER: preview,
      PREVIEW_COOKIE_SECRET: secret(),
    };
    await writeFile(
      join(base, ".dev.vars"),
      Object.entries(secrets)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("\n"),
      { mode: 0o600 },
    );
    const child = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        ...paths.flatMap((p) => ["--config", p]),
        "--ip",
        "127.0.0.1",
        "--port",
        String(workerPort),
        "--inspector-port",
        "0",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: directory,
          TMPDIR: directory,
          WRANGLER_SEND_METRICS: "false",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    await ready(child);
    child.stdout.resume();
    child.stderr.resume();
  }
  const origin = (i) => `http://127.0.0.1:${ports[i]}`;
  const request = (i, path, init = {}) =>
    fetch(`${origin(i)}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  const control = (i, path) =>
    request(i, path, { method: "POST", headers: { Authorization: `Bearer ${bearer}` } });
  seeded = true;
  const seed = await control(0, "/__f08/seed");
  if (!seed.ok) throw Error("f08_seed_failed");
  const { taskId, validCookie, expiredCookie } = await seed.json();
  if (taskId !== fixtureId) throw Error("f08_fixture_scope_changed");
  const appHeaders = (cookie) => ({
    Cookie: cookie,
    Authorization: `Bearer ${preview}`,
    "sec-fetch-site": "same-origin",
  });
  const good = await request(0, "/api/delivery/tasks", {
    headers: appHeaders(validCookie),
  });
  if (!good.ok) {
    const body = await good.json().catch(() => null);
    const code =
      typeof body?.error === "string" && /^[a-z_]{1,60}$/.test(body.error) ? body.error : "unknown";
    throw Error(`f08_authenticated_read_failed_${good.status}_${code}`);
  }
  if (!(await good.json()).tasks?.some((task) => task.id === fixtureId))
    throw Error("f08_authenticated_read_scope");
  const tampered = await request(0, "/api/delivery/tasks", {
    headers: appHeaders(`${validCookie.slice(0, -1)}${validCookie.endsWith("0") ? "1" : "0"}`),
  });
  if (tampered.status !== 401) throw Error("f08_tampered_cookie_accepted");
  const legacy = await request(0, "/api/delivery/tasks", {
    headers: appHeaders(validCookie.replace(/^__Host-hive-session=/, "hive-session=")),
  });
  if (legacy.status !== 401) throw Error("f08_legacy_cookie_accepted");
  const expired = await request(0, "/api/delivery/tasks", {
    headers: appHeaders(expiredCookie),
  });
  if (expired.status !== 401) throw Error("f08_expired_session_accepted");
  const token = await control(0, "/__f08/token"),
    tokenResult = await token.json();
  if (!token.ok || tokenResult.accepted !== true) throw Error("f08_synthetic_decryption_failed");
  const wrong = await control(1, "/__f08/token"),
    wrongResult = await wrong.json();
  if (!wrong.ok || wrongResult.wrongKeyRejected !== true)
    throw Error("f08_wrong_encryption_key_accepted");
  const auth = await control(0, "/__f08/reject-service-key"),
    authResult = await auth.json();
  if (!auth.ok || authResult.rejected !== true) throw Error("f08_wrong_service_key_accepted");
  const logout = await request(0, "/api/auth/logout", {
    method: "POST",
    headers: { ...appHeaders(validCookie), Origin: origin(0) },
  });
  if (!logout.ok) throw Error("f08_logout_failed");
  const cookies = logout.headers.getSetCookie(),
    cleared = cookies.find((c) => c.startsWith("__Host-hive-session="));
  if (
    !cleared ||
    !/;\s*secure(?:;|$)/i.test(cleared) ||
    !/;\s*httponly(?:;|$)/i.test(cleared) ||
    !/;\s*path=\//i.test(cleared) ||
    !/;\s*max-age=0(?:;|$)/i.test(cleared) ||
    /;\s*domain=/i.test(cleared)
  )
    throw Error("f08_logout_cookie_flags_invalid");
  const revoked = await request(0, "/api/delivery/tasks", {
    headers: appHeaders(validCookie),
  });
  if (revoked.status !== 401) throw Error("f08_logged_out_session_accepted");
  fingerprint(ownerFile, captureFile, dumpFile, fixtureId);
  const cleanup = await control(0, "/__f08/cleanup");
  if (!cleanup.ok || (await cleanup.json()).cleaned !== true) throw Error("f08_cleanup_failed");
  await cleanupF08User({ ownerFile, fixtureId });
  cleanupSucceeded = true;
  const after = fingerprint(ownerFile, captureFile, dumpFile);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      sourceSha: "52c4b2e0141c450ed8e030b138d491277297b3ce",
      archiveSha256: sha(bytes),
      appDigest,
      authDigest,
      fixtureId,
      role: role.role,
      originalTables: Object.keys(after).length,
      originalRows: Object.values(after).reduce((n, v) => n + v.count, 0),
      originalFingerprintsMatch: true,
      checks: {
        syntheticAuthenticatedRead: true,
        tamperedCookieRejected: true,
        legacyCookieRejected: true,
        expiredSessionRejected: true,
        syntheticCredentialDecrypted: true,
        wrongEncryptionKeyRejected: true,
        wrongServiceKeyRejected: true,
        logoutRevoked: true,
        secureLogoutCookie: true,
        syntheticCleanup: true,
      },
      scope:
        "isolated restored Neon database; no original credential decrypted or live Coder called",
      runtimeRoleCleanup: "retained for separately reviewed revocation",
      privateStateDirectory: directory,
    }),
  );
} finally {
  if (seeded && !cleanupSucceeded && children.length) {
    try {
      const cleanup = await fetch(`http://127.0.0.1:${ports[0]}/__f08/cleanup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10000),
      });
      if (cleanup.ok) await cleanupF08User({ ownerFile, fixtureId });
    } catch {}
  }
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  // Private role connection and checkpoint remain for recovery and reviewed cleanup.
  for (const index of [0, 1]) {
    await rm(join(directory, String(index)), { recursive: true, force: true });
  }
}
