import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { artifactDigest, readReleaseArtifact } from "../../../../scripts/release/artifact.mjs";
import {
  compatibilityDatabaseTransport,
  startSourceCompatibilityWorker,
} from "./compatibility-ws.mjs";
import { digest, requireValue } from "./contracts.mjs";
import { sourceBuildCompatibilitySchema, workerdCompatibilitySchema } from "./wire.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function download(url, fetcher) {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
  requireValue(response.ok && response.body, "migration_compatibility_artifact_unavailable");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      requireValue(size <= 128 * 1024 * 1024, "migration_compatibility_artifact_limit");
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return readReleaseArtifact(Buffer.concat(chunks));
}
async function port() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const value = server.address().port;
  await new Promise((ok, fail) => server.close((e) => (e ? fail(e) : ok())));
  return value;
}
async function ready(child, text) {
  return new Promise((ok, fail) => {
    let output = "";
    const timer = setTimeout(() => done(Error("migration_compatibility_workerd_timeout")), 30000);
    const done = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", data);
      child.stderr.off("data", data);
      child.off("exit", exit);
      error ? fail(error) : ok();
    };
    const data = (part) => {
      output += part.toString();
      if (output.length > 65536) output = output.slice(-65536);
      if (output.includes(text)) done();
    };
    const exit = () => done(Error("migration_compatibility_workerd_failed"));
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.once("exit", exit);
  });
}
/** The only executable scenario is pinned in the reviewed workflow checkout.
 * Candidate release archives are data until loaded inside workerd. */
export async function runWorkerdCompatibility(
  raw,
  { fetcher = fetch, fixtureDatabaseUrl, sourceArtifacts, sourceArtifactDigests } = {},
) {
  const single = raw?.kind === "automatic-source-build";
  const config = single
    ? sourceBuildCompatibilitySchema.parse(raw)
    : workerdCompatibilitySchema.parse(raw);
  const root = await realpath(process.cwd()),
    scenario = await realpath(resolve(root, config.scenarioPath));
  requireValue(
    scenario.startsWith(`${root}/scripts/release/compatibility/`) &&
      sha256(await readFile(scenario)) === config.scenarioDigest,
    "migration_compatibility_scenario_changed",
  );
  const [oldFiles, newFiles] = single
    ? await Promise.all(
        ["old", "new"].map((name) => {
          requireValue(
            sourceArtifacts?.[name] instanceof Buffer,
            "migration_source_artifacts_missing",
          );
          return readReleaseArtifact(sourceArtifacts[name], { topology: "single" });
        }),
      )
    : await Promise.all([
        download(config.oldArtifactUrl, fetcher),
        download(config.newArtifactUrl, fetcher),
      ]);
  const expectedDigests = single ? sourceArtifactDigests : config;
  requireValue(
    expectedDigests &&
      artifactDigest(oldFiles, "app") === expectedDigests.oldAppDigest &&
      artifactDigest(newFiles, "app") === expectedDigests.newAppDigest &&
      (single ||
        (artifactDigest(oldFiles, "auth") === config.oldAuthDigest &&
          artifactDigest(newFiles, "auth") === config.newAuthDigest)),
    "migration_compatibility_artifact_changed",
  );
  const directory = await mkdtemp(join(tmpdir(), "hive-d10-workerd-")),
    suffix = randomBytes(12).toString("hex"),
    pg = `hive-d10-${suffix}`,
    password = randomBytes(24).toString("hex"),
    children = [],
    sourceWorkers = [];
  let databaseTransport;
  const docker = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const safeEnv = {
    PATH: process.env.PATH ?? "",
    HOME: directory,
    TMPDIR: directory,
    WRANGLER_SEND_METRICS: "false",
  };
  try {
    let databaseUrl;
    if (fixtureDatabaseUrl) {
      const u = new URL(fixtureDatabaseUrl);
      requireValue(
        ["localhost", "127.0.0.1"].includes(u.hostname) &&
          /^\/hive_d10_test(?:_[a-z0-9_]+)?$/.test(u.pathname),
        "migration_compatibility_fixture_scope",
      );
      databaseUrl = fixtureDatabaseUrl;
    } else {
      docker(["pull", config.postgresImage]);
      requireValue(
        JSON.parse(
          docker(["image", "inspect", "--format", "{{json .RepoDigests}}", config.postgresImage]),
        ).includes(config.postgresImage),
        "migration_compatibility_image_changed",
      );
      docker([
        "run",
        "-d",
        "--name",
        pg,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "-p",
        "127.0.0.1::5432",
        "-e",
        "POSTGRES_USER=hive",
        ...(single ? ["-e", "POSTGRES_HOST_AUTH_METHOD=password"] : []),
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=hive_compatibility",
        config.postgresImage,
      ]);
      let available = false;
      for (let i = 0; i < 30 && !available; i++) {
        try {
          docker(["exec", pg, "pg_isready", "-U", "hive", "-d", "hive_compatibility", "-t", "1"]);
          available = true;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      requireValue(available, "migration_compatibility_database_unavailable");
      const mapped = docker(["port", pg, "5432/tcp"]),
        match = /^127\.0\.0\.1:(\d+)$/.exec(mapped);
      requireValue(
        match && Number(match[1]) > 0 && Number(match[1]) < 65536,
        "migration_compatibility_database_unavailable",
      );
      databaseUrl = `postgresql://hive:${password}@127.0.0.1:${match[1]}/hive_compatibility`;
    }
    const ports = [await port(), await port()];
    requireValue(ports[0] !== ports[1], "migration_compatibility_port_collision");
    const scenarioEnv = {
      ...safeEnv,
      DATABASE_URL: databaseUrl,
      HIVE_PLAN_DIGEST: single ? config.planIntentDigest : config.planDigest,
      HIVE_SOURCE_SHA: config.sourceSha,
      HIVE_COMPATIBILITY_DIGEST: config.compatibilityDigest,
      HIVE_OLD_APP: `http://127.0.0.1:${ports[0]}`,
      HIVE_NEW_APP: `http://127.0.0.1:${ports[1]}`,
    };
    const scenarioRun = (action) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scenario, action], {
          env: scenarioEnv,
          stdio: "ignore",
          detached: true,
        });
        const closed = new Promise((done) => child.once("close", done));
        children.push({ child, closed });
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 120000);
        child.once("error", () => {
          clearTimeout(timer);
          reject(Error("migration_compatibility_scenario_failed"));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(Error("migration_compatibility_scenario_failed"));
        });
      });
    await scenarioRun("prepare");
    if (single)
      databaseTransport = await compatibilityDatabaseTransport(databaseUrl, {
        knownTrustFixture: !!fixtureDatabaseUrl && !new URL(fixtureDatabaseUrl).password,
      });
    const isolatedKeys = single
      ? Object.fromEntries(
          [
            "AUTH_SERVICE_SECRET",
            "ENCRYPTION_KEY",
            "COOKIE_SECRET",
            "HIVE_CODER_OAUTH_CLIENT_SECRET",
          ].map((name) => [name, randomBytes(32).toString("hex")]),
        )
      : {};
    for (const [index, files] of [oldFiles, newFiles].entries()) {
      const base = join(directory, String(index));
      for (const [path, bytes] of files) {
        const dest = join(base, path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
      }
      await mkdir(join(base, "assets"), { recursive: true });
      const path = join(base, "wrangler.json"),
        authPath = join(base, "auth.json"),
        authName = `hive-d10-auth-${suffix}-${index}`;
      if (!single)
        await writeFile(
          authPath,
          JSON.stringify({
            name: authName,
            main: join(base, "auth/worker.js"),
            compatibility_date: config.compatibilityDate,
            compatibility_flags: ["nodejs_compat"],
            no_bundle: true,
            vars: { DATABASE_URL: databaseUrl },
          }),
        );
      const origin = `http://127.0.0.1:${ports[index]}`;
      const isolated = single
        ? {
            ...isolatedKeys,
            HIVE_NATIVE_MODE: "preview",
            HIVE_NATIVE_PREVIEW_ENABLED: "true",
            HIVE_NATIVE_PRODUCTION_ACTIVE: "false",
            HIVE_PREVIEW_ACCESS_REQUIRED: "false",
            HIVE_PUBLIC_ORIGIN: origin,
            HIVE_PREVIEW_ORIGIN: origin,
            HIVE_CODER_OAUTH_ENABLED: "true",
            CODER_URL: "https://coder.compatibility.invalid",
            HIVE_CODER_OAUTH_CLIENT_ID: "isolated-compatibility",
            HIVE_DELIVERY_RELEASE_ENABLED: "false",
            HIVE_DELIVERY_DATABASE_ENABLED: "false",
            HIVE_TOKEN_ROTATION_ENABLED: "false",
          }
        : {};
      if (single) {
        sourceWorkers.push(
          await startSourceCompatibilityWorker({
            files,
            directory: base,
            port: ports[index],
            bindings: { DATABASE_URL: databaseUrl, ...isolated },
            date: config.compatibilityDate,
            transport: databaseTransport,
            version: index,
          }),
        );
        continue;
      }
      await writeFile(
        path,
        JSON.stringify({
          name: `hive-d10-${suffix}-${index}`,
          main: join(base, "app/worker.js"),
          compatibility_date: config.compatibilityDate,
          compatibility_flags: ["nodejs_compat"],
          no_bundle: true,
          vars: { DATABASE_URL: databaseUrl, ...isolated },
          ...(single ? {} : { services: [{ binding: "AUTH_SERVICE", service: authName }] }),
          assets: { directory: join(base, "assets"), binding: "ASSETS", run_worker_first: true },
        }),
      );
      const child = spawn(
        "pnpm",
        [
          "exec",
          "wrangler",
          "dev",
          "--config",
          path,
          ...(!single ? ["--config", authPath] : []),
          "--ip",
          "127.0.0.1",
          "--port",
          String(ports[index]),
          "--inspector-port",
          "0",
        ],
        { cwd: root, env: safeEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      // Install before readiness: a failed or early-exiting Wrangler must also
      // be reaped before its temporary HOME is removed.
      const closed = new Promise((resolve) => child.once("close", resolve));
      children.push({ child, closed });
      await ready(child, "Ready on");
      child.stdout.resume();
      child.stderr.resume();
    }
    await scenarioRun("verify");
    if (single)
      requireValue(
        databaseTransport.counts.every((stats) => stats.queries > 0),
        "migration_compatibility_application_database_unverified",
      );
    return {
      schemaVersion: single ? 2 : 1,
      ...(single
        ? {
            kind: "automatic-source-build",
            applicationDatabase: {
              transport: "isolated-neon-websocket",
              queries: databaseTransport.counts.map((stats) => stats.queries),
            },
            sourceBuild: {
              baseline: config.baseline,
              candidate: config.candidate,
              artifactMeaning: "local-compatibility-test",
            },
          }
        : {}),
      catalogDigest: digest(config),
      ...(single
        ? { planIntentDigest: config.planIntentDigest }
        : { planDigest: config.planDigest }),
      sourceSha: config.sourceSha,
      oldAppDigest: expectedDigests.oldAppDigest,
      newAppDigest: expectedDigests.newAppDigest,
      compatibilityDigest: config.compatibilityDigest,
    };
  } finally {
    try {
      await Promise.all(sourceWorkers.map((worker) => worker.dispose()));
    } finally {
      try {
        if (databaseTransport) await databaseTransport.close();
      } finally {
        for (const { child } of children) {
          try {
            if (child.pid && child.exitCode === null && child.signalCode === null)
              process.kill(-child.pid, "SIGTERM");
          } catch {}
        }
        try {
          await Promise.all(
            children.map(async ({ child, closed }) => {
              const kill = setTimeout(() => {
                try {
                  if (child.pid && child.exitCode === null && child.signalCode === null)
                    process.kill(-child.pid, "SIGKILL");
                } catch {}
              }, 5000);
              let deadline;
              try {
                await Promise.race([
                  closed,
                  new Promise((_, reject) => {
                    deadline = setTimeout(
                      () => reject(Error("migration_compatibility_cleanup_timeout")),
                      10000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(kill);
                clearTimeout(deadline);
              }
            }),
          );
        } finally {
          if (!fixtureDatabaseUrl) {
            try {
              docker(["rm", "-f", pg]);
            } catch {}
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
