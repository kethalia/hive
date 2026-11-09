// Local-only pilot coordinator. Run only with dedicated synthetic Neon DB and
// two reviewed release archives; never import into the installed application.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runPilotMigration, verifyPilotInvariant } from "./d10-pilot-migration.mjs";

const root = process.cwd();
const required = (value) => {
  if (!value) throw Error("pilot_configuration_unavailable");
  return value;
};
const runId = randomUUID(),
  temp = await mkdtemp(join(tmpdir(), "hive-d10-pilot-"));
const random = () => randomBytes(32).toString("hex");
const bearer = random(),
  preview = random(),
  cookieSecret = random(),
  authSecret = random(),
  encryptionKey = random();
const children = [];
const expectedHash = (v) => {
  if (!/^[a-f0-9]{64}$/.test(v ?? "")) throw Error("pilot_artifact_hash_missing");
  return v;
};
async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const port = server.address().port;
  await new Promise((ok, fail) => server.close((e) => (e ? fail(e) : ok())));
  return port;
}
async function awaitReady(child) {
  return new Promise((ok, fail) => {
    let text = "";
    const timer = setTimeout(() => done(Error("pilot_worker_timeout")), 60000);
    const done = (e) => {
      clearTimeout(timer);
      child.off("exit", exit);
      child.stdout.off("data", data);
      child.stderr.off("data", data);
      e ? fail(e) : ok();
    };
    const exit = () => done(Error("pilot_worker_exited"));
    const data = (chunk) => {
      text += chunk.toString();
      if (text.length > 65536) text = text.slice(-65536);
      if (text.includes("Ready on")) done();
    };
    child.once("exit", exit);
    child.stdout.on("data", data);
    child.stderr.on("data", data);
  });
}
try {
  const databaseUrl = (
      await readFile(required(process.env.HIVE_D10_PILOT_DATABASE_FILE), "utf8")
    ).trim(),
    db = new URL(databaseUrl);
  if (db.pathname !== "/hive_d10_pilot" || !db.hostname.endsWith(".aws.neon.tech"))
    throw Error("pilot_database_scope");
  const modulePath = resolve(
    required(process.env.HIVE_D10_DELIVERY_REPOSITORY),
    "scripts/release/artifact.mjs",
  );
  const { readReleaseArtifact, artifactDigest } = await import(pathToFileURL(modulePath).href);
  const artifacts = [];
  for (const label of ["OLD", "NEW"]) {
    const raw = await readFile(required(process.env[`HIVE_D10_PILOT_${label}_ARCHIVE`]));
    if (
      createHash("sha256").update(raw).digest("hex") !==
      expectedHash(process.env[`HIVE_D10_PILOT_${label}_ARCHIVE_SHA256`])
    )
      throw Error("pilot_archive_changed");
    const files = await readReleaseArtifact(raw),
      app = artifactDigest(files, "app"),
      auth = artifactDigest(files, "auth");
    artifacts.push({ files, app, auth });
  }
  const ports = [await freePort(), await freePort()];
  if (ports[0] === ports[1]) throw Error("pilot_port_collision");
  for (const [index, artifact] of artifacts.entries()) {
    const base = join(temp, String(index));
    for (const [name, bytes] of artifact.files) {
      const path = join(base, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
    }
    await mkdir(join(base, "assets"), { recursive: true });
    const name = `hive-d10-pilot-${runId}-${index}`,
      appName = `${name}-app`,
      authName = `${name}-auth`,
      date = "2026-10-29";
    const common = {
      compatibility_date: date,
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      workers_dev: false,
      preview_urls: false,
    };
    const config = {
      ...common,
      name,
      main: resolve("deploy/cloudflare/auth/d10-pilot-fixture.worker.ts"),
      services: [{ binding: "APP", service: appName }],
    };
    const vars = {
      HIVE_RUNTIME_TARGET: "cloudflare",
      HIVE_DELIVERY_ENABLED: "true",
      HIVE_DISABLE_BACKGROUND_WORKERS: "true",
      HIVE_PROJECT_TASKS_ENABLED: "false",
      HIVE_TOKEN_ROTATION_ENABLED: "false",
      CODER_URL: "https://coder.invalid",
      HIVE_PREVIEW_ORIGIN: `http://127.0.0.1:${ports[index]}`,
    };
    const app = {
      ...common,
      name: appName,
      main: join(base, "app/worker.js"),
      no_bundle: true,
      services: [{ binding: "AUTH_SERVICE", service: authName }],
      assets: { directory: join(base, "assets"), binding: "ASSETS", run_worker_first: true },
      vars,
    };
    const auth = {
      ...common,
      name: authName,
      main: join(base, "auth/worker.js"),
      no_bundle: true,
      vars,
    };
    const paths = ["front", "app", "auth"].map((n) => join(base, `${n}.json`));
    for (const [i, value] of [config, app, auth].entries())
      await writeFile(paths[i], JSON.stringify(value), { mode: 0o600 });
    const secrets = {
      DATABASE_URL: databaseUrl,
      AUTH_SERVICE_SECRET: authSecret,
      ENCRYPTION_KEY: encryptionKey,
      COOKIE_SECRET: cookieSecret,
      PILOT_BEARER: bearer,
      PREVIEW_BEARER: preview,
      PREVIEW_COOKIE_SECRET: random(),
      RUN_UUID: runId,
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
        String(ports[index]),
        "--inspector-port",
        "0",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: temp,
          TMPDIR: temp,
          WRANGLER_SEND_METRICS: "false",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    await awaitReady(child);
    child.stdout.resume();
    child.stderr.resume();
  }
  const origin = (i) => `http://127.0.0.1:${ports[i]}`;
  const fetchAt = (i, path, init = {}) =>
    fetch(`${origin(i)}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  const seed = await fetchAt(0, "/__d10-pilot/seed", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!seed.ok) throw Error("pilot_seed_failed");
  const { cookie, taskId } = await seed.json();
  const headers = {
    Cookie: cookie,
    Authorization: `Bearer ${preview}`,
    "sec-fetch-site": "same-origin",
  };
  async function read(i, paused, version) {
    const response = await fetchAt(i, `/api/delivery/tasks/${taskId}`, { headers });
    if (!response.ok) throw Error("pilot_task_read_failed");
    const task = await response.json();
    if (task.id !== taskId || task.pauseRequested !== paused || task.version !== version)
      throw Error("pilot_task_scope_changed");
    return task;
  }
  async function pause(i, paused, expectedVersion) {
    const response = await fetchAt(i, `/api/delivery/tasks/${taskId}/pause`, {
      method: "POST",
      headers: { ...headers, Origin: origin(i), "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), expectedVersion, paused }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code =
        typeof body?.error === "string" && /^[a-z_]{1,50}$/.test(body.error)
          ? body.error
          : "unknown";
      throw Error(`pilot_pause_failed_${response.status}_${code}`);
    }
    return response.json();
  }
  await read(0, false, 0);
  await read(1, false, 0);
  const first = await pause(0, true, 0);
  await read(1, true, first.version);
  const migration =
    process.env.HIVE_D10_PILOT_MIGRATION === "true"
      ? await runPilotMigration({
          repository: required(process.env.HIVE_D10_DELIVERY_REPOSITORY),
          ownerFile: required(process.env.HIVE_D10_PILOT_OWNER_FILE),
          appDigests: artifacts.map((x) => x.app),
          checkpointFile: required(process.env.HIVE_D10_PILOT_CHECKPOINT_FILE),
          sourceSha: required(process.env.HIVE_D10_PILOT_SOURCE_SHA),
        })
      : null;
  if (migration) {
    await read(0, true, first.version);
    await read(1, true, first.version);
  }
  const second = await pause(1, false, first.version);
  await read(0, false, second.version);
  if (second.version !== first.version + 1) throw Error("pilot_version_changed");
  if (migration)
    await verifyPilotInvariant({
      repository: required(process.env.HIVE_D10_DELIVERY_REPOSITORY),
      ownerFile: required(process.env.HIVE_D10_PILOT_OWNER_FILE),
      taskId,
    });
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      fixture: "dedicated synthetic database",
      oldAppDigest: artifacts[0].app,
      oldAuthDigest: artifacts[0].auth,
      newAppDigest: artifacts[1].app,
      newAuthDigest: artifacts[1].auth,
      checks: { oldAndNewRead: true, oldWriteNewRead: true, newWriteOldRead: true },
      migration,
      postWriteIntegrity: Boolean(migration),
      runId,
    }),
  );
} finally {
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await rm(temp, { recursive: true, force: true });
}
