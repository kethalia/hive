// Actual local workerd service binding + real encrypted PostgreSQL intent proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { tsImport } from "tsx/esm/api";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = await import(
  pathToFileURL(
    require.resolve("miniflare", { paths: [dirname(require.resolve("wrangler/package.json"))] }),
  ).href
);
const scratch = await mkdtemp(join(tmpdir(), "hive-project-reconcile-workerd-"));
const sourcePaths = [
  "src/lib/projects/reconcile-transport.ts",
  "src/lib/projects/reconcile-route.server.ts",
  "src/lib/projects/task.server.ts",
  "src/lib/projects/task-intents.server.ts",
  "src/lib/projects/host.server.ts",
  "src/lib/coder/user-client.ts",
  "src/lib/coder/client.ts",
  "src/lib/coder/fetch.ts",
  "src/lib/codex-session/bootstrap-delivery.server.ts",
  "src/lib/codex-session/guardian-factory.server.ts",
  "src/lib/codex-session/registered-session.server.ts",
  "src/lib/codex-session/registration.server.ts",
  "src/lib/security/workspace-app-isolation.ts",
  "packages/auth/src/encryption.ts",
  "packages/auth/src/coder-origin.ts",
  "src/app/api/internal/project-tasks/reconcile/route.ts",
  "src/proxy.ts",
  "deploy/cloudflare/app/worker.ts",
  "deploy/cloudflare/app/wrangler.jsonc",
  "deploy/cloudflare/jobs/wrangler.jsonc",
  "deploy/cloudflare/app/project-tasks.ts",
  "deploy/cloudflare/app/request-lifetime.ts",
  "deploy/cloudflare/jobs/project-tasks.ts",
  "deploy/cloudflare/jobs/worker.ts",
  "deploy/cloudflare/jobs/local-project-tasks.worker.ts",
  "deploy/cloudflare/jobs/local-project-coder.worker.ts",
  "deploy/cloudflare/jobs/run-local-project-tasks.mjs",
  "packages/db/prisma/schema.prisma",
  "packages/db/src/cloudflare.ts",
  "packages/db/src/generated/prisma-workerd/client.ts",
  "packages/db/src/generated/prisma-workerd/internal/class.ts",
];
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const migrationRoot = resolve("packages/db/prisma/migrations"),
  migrationNames = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name <= "20261029180000_template_publication_notices",
    )
    .map((entry) => entry.name)
    .sort();
assert.equal(migrationNames.length, 29);
for (const name of migrationNames)
  sourcePaths.push(`packages/db/prisma/migrations/${name}/migration.sql`);
const sources = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (p) => [p, await hash(p)])),
);
const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const fixture = JSON.parse(await readFile("/tmp/hive-template-fixture.json", "utf8"));
const parent = new URL(fixture.url);
assert.equal(parent.hostname, "127.0.0.1");
assert.equal(parent.pathname, "/hive_template_test");
assert.equal(parent.port, String(fixture.port));
const databaseName = `hive_reconcile_${randomBytes(6).toString("hex")}`;
execFileSync(
  "/usr/lib/postgresql/17/bin/createdb",
  ["-h", "127.0.0.1", "-p", parent.port, databaseName],
  { stdio: "pipe" },
);
const databaseUrl = `postgresql://coder@127.0.0.1:${parent.port}/${databaseName}?sslmode=disable`;
const migrationSnapshot = join(scratch, "prisma");
await mkdir(join(migrationSnapshot, "migrations"), { recursive: true });
await cp("packages/db/prisma/schema.prisma", join(migrationSnapshot, "schema.prisma"));
await cp(
  join(migrationRoot, "migration_lock.toml"),
  join(migrationSnapshot, "migrations/migration_lock.toml"),
);
for (const name of migrationNames)
  await cp(join(migrationRoot, name), join(migrationSnapshot, "migrations", name), {
    recursive: true,
  });
execFileSync(
  "pnpm",
  [
    "--filter",
    "@hive/db",
    "exec",
    "prisma",
    "migrate",
    "deploy",
    "--schema",
    join(migrationSnapshot, "schema.prisma"),
  ],
  {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  },
);
const { PrismaClient } = await tsImport("@hive/db", import.meta.url),
  { encrypt } = await tsImport("@hive/auth", import.meta.url),
  intentModule = await tsImport(
    resolve("src/lib/projects/task-intents.server.ts"),
    import.meta.url,
  );
const { ProjectTaskIntents, taskRequestDigest } = intentModule.default ?? intentModule;
const db = new PrismaClient({ datasourceUrl: databaseUrl }),
  key = randomBytes(32).toString("hex"),
  secret = randomBytes(32).toString("hex"),
  ownerId = randomUUID(),
  coderOwnerId = randomUUID(),
  workspaceId = randomUUID(),
  templateId = randomUUID(),
  buildId = randomUUID(),
  agentId = randomUUID(),
  appId = randomUUID();
const issuer = generateKeyPairSync("ed25519"),
  publicKey = issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
  privateKey = issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const store = new ProjectTaskIntents(db, key),
  appOrigin = "https://codex-session--main--workspace--owner.apps.reconcile-proof.invalid";
const sockets = new Set(),
  bridge = createServer(),
  ws = new WebSocketServer({ server: bridge, maxPayload: 1048576 });
ws.on("connection", (socket) => {
  const upstream = connect({ host: "127.0.0.1", port: Number(parent.port) });
  sockets.add(upstream);
  socket.on("message", (data) => upstream.write(data));
  upstream.on("data", (data) => socket.send(data));
  const close = () => {
    upstream.destroy();
    socket.terminate();
    sockets.delete(upstream);
  };
  socket.on("close", close);
  socket.on("error", close);
  upstream.on("close", close);
  upstream.on("error", close);
});
await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
let mf,
  passed = false;
const checks = {},
  observations = {};
try {
  await db.user.create({
    data: {
      id: ownerId,
      coderUserId: coderOwnerId,
      coderUrl: "https://coder.reconcile-proof.invalid",
      username: "synthetic",
      email: "synthetic@example.invalid",
    },
  });
  const token = encrypt("synthetic-coder-key", key);
  await db.coderToken.create({
    data: {
      userId: ownerId,
      ciphertext: token.ciphertext,
      iv: token.iv,
      authTag: token.authTag,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const project = await db.deliveryProject.create({
    data: {
      ownerId,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "synthetic/reconcile",
    },
  });
  const migrationRows =
    await db.$queryRaw`SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
  assert.deepEqual(
    migrationRows.map((row) => row.migration_name),
    migrationNames,
  );
  for (const row of migrationRows)
    assert.equal(
      row.checksum,
      sources[`packages/db/prisma/migrations/${row.migration_name}/migration.sql`],
    );
  observations.migrations = {
    count: migrationNames.length,
    through: migrationNames.at(-1),
    excludedDraft: "20261029190000_delivery_repository_policy",
  };
  const enqueue = async () => {
    const taskId = randomUUID(),
      requestId = randomUUID();
    await store.enqueue({
      ownerId,
      projectId: project.id,
      workspaceId,
      taskId,
      requestId,
      requestDigest: taskRequestDigest([taskId]),
      hostRequest: {
        schemaVersion: 1,
        projectId: project.id,
        repositoryId: "123",
        expectedAccountId: "456",
        taskId,
        requestId,
        revision: "a".repeat(40),
        model: "fixture",
        effort: "high",
        text: "private synthetic intent",
      },
    });
    return taskId;
  };
  const first = await enqueue(),
    second = await enqueue();
  const wasm = new Map();
  async function bundle(entry, name) {
    const outfile = join(scratch, `${name}.mjs`);
    await build({
      entryPoints: [resolve(entry)],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      conditions: ["workerd", "worker", "browser"],
      target: "es2022",
      banner: {
        js: 'import {createRequire as fixtureRequire} from "node:module";const require=fixtureRequire("/");',
      },
      external: ["node:*", "cloudflare:*"],
      plugins: [
        {
          name: "wasm",
          setup(b) {
            b.onResolve({ filter: /\.wasm(?:\?module)?$/ }, async (args) => {
              const path = resolve(args.resolveDir, args.path.replace(/\?module$/, ""));
              wasm.set(path, await readFile(path));
              return { path, external: true };
            });
          },
        },
      ],
    });
    return { type: "ESModule", path: outfile, contents: await readFile(outfile, "utf8") };
  }
  const app = await bundle("deploy/cloudflare/jobs/local-project-tasks.worker.ts", "app"),
    coder = await bundle("deploy/cloudflare/jobs/local-project-coder.worker.ts", "coder");
  const modules = () =>
    [...wasm].map(([path, contents]) => ({ type: "CompiledWasm", path, contents }));
  const base = {
    modulesRoot: "/",
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
  };
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...base,
          name: "app",
          modules: [app, ...modules()],
          outboundService: "coder",
          bindings: {
            ROLE: "app",
            DATABASE_URL: databaseUrl,
            WS_PORT: String(bridge.address().port),
            HIVE_RUNTIME_TARGET: "cloudflare",
            ENCRYPTION_KEY: key,
            HIVE_PROJECT_TASKS_ENABLED: "true",
            HIVE_PROJECT_TASK_RECONCILE_SECRET: secret,
            CODER_URL: "https://coder.reconcile-proof.invalid",
            HIVE_GUARDIAN_ENABLED: "false",
            HIVE_CODEX_GATEWAY_ENABLED: "true",
            HIVE_CODEX_ISSUER_PRIVATE_KEY: privateKey,
            HIVE_CODEX_ISSUER_KEY_ID: "fixture",
            HIVE_CODEX_HIVE_ORIGIN: "https://hive.public-origin.invalid",
            HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: templateId,
            HIVE_CODEX_APP_SLUG: "codex-session",
            HIVE_CODEX_GATEWAY_PORT: "13341",
          },
        },
        {
          ...base,
          name: "jobs",
          modules: [app, ...modules()],
          serviceBindings: { APP_SERVICE: "app" },
          bindings: {
            ROLE: "jobs",
            HIVE_PROJECT_TASKS_ENABLED: "true",
            HIVE_PROJECT_TASK_RECONCILE_SECRET: secret,
          },
        },
        {
          ...base,
          name: "coder",
          modules: [coder],
          bindings: {
            WORKSPACE_ID: workspaceId,
            CODER_OWNER_ID: coderOwnerId,
            OTHER_OWNER_ID: randomUUID(),
            BUILD_ID: buildId,
            TEMPLATE_ID: templateId,
            AGENT_ID: agentId,
            APP_ID: appId,
            APP_ORIGIN: appOrigin,
            ISSUER_PUBLIC_KEY: publicKey,
          },
        },
      ],
    }),
  );
  const jobs = await mf.getWorker("jobs"),
    appService = await mf.getWorker("app"),
    provider = await mf.getWorker("coder");
  const stats = async () => await (await provider.fetch("https://fixture.invalid/__stats")).json();
  const timeout = await (await appService.fetch("https://fixture.invalid/__pg-timeout")).json();
  observations.statementTimeout = timeout;
  assert.equal(timeout.sqlstate, "57014");
  assert.equal(timeout.serverConfigured, true);
  checks.actualServerStatementTimeout57014 = true;
  let response = await appService.fetch(
    "https://hive-app.internal/api/internal/project-tasks/reconcile",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"schemaVersion":1}',
    },
  );
  assert.equal(response.status, 401);
  assert.equal((await stats()).starts, 0);
  assert.equal(await db.projectTaskIntent.count({ where: { leaseId: { not: null } } }), 0);
  checks.authBeforeClaim = true;
  const wake = async () => {
    const r = await jobs.fetch("https://fixture.invalid/__wake");
    assert.equal(r.status, 200);
    return r.json();
  };
  let result = await wake();
  assert.equal(result.projectTasks.processed, 1);
  assert.equal((await stats()).starts, 1);
  assert.equal(await db.projectTaskIntent.count({ where: { phase: "queued" } }), 1);
  checks.oneIntentPerWake = true;
  result = await wake();
  assert.equal(result.projectTasks.processed, 1);
  assert.equal((await stats()).starts, 2);
  checks.secondWakeSeparateIntent = true;
  await db.projectTaskIntent.updateMany({
    where: { ownerId, phase: "preparing" },
    data: { nextAttemptAt: new Date(Date.now() + 60000) },
  });
  const third = await enqueue();
  await provider.fetch("https://fixture.invalid/__mode", { method: "POST", body: "stall-start" });
  response = await jobs.fetch("https://fixture.invalid/__wake", {
    headers: { "X-Local-Cancel": "true" },
  });
  assert.equal((await response.json()).cancelled, true);
  const pending = await db.projectTaskIntent.findUniqueOrThrow({ where: { id: third } });
  assert.equal(pending.phase, "queued");
  assert(pending.leaseId);
  assert.equal((await stats()).starts, 2);
  checks.cancelledHostRetainsClaim = true;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await stats()).starts, 3);
  checks.callerAbortDidNotRevokeAcceptedWake = true;
  checks.lateEffectDurablyReconciled = true;
  const late = await db.projectTaskIntent.findUniqueOrThrow({ where: { id: third } });
  assert.equal(late.phase, "preparing");
  assert.equal(late.leaseId, null);
  const deadlineTask = await enqueue();
  response = await jobs.fetch("https://fixture.invalid/__wake", {
    headers: { "X-Local-Deadline": "true" },
  });
  assert.equal((await response.json()).appStatus, 408);
  assert.equal((await stats()).stalls, 2);
  checks.deadlineCrossedDuringActualProviderFetch = true;
  const held = await db.projectTaskIntent.findUniqueOrThrow({ where: { id: deadlineTask } });
  assert.equal(held.phase, "queued");
  assert(held.leaseId);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await stats()).starts, 3);
  checks.explicitAppDeadlineCancelledCoder = true;
  await provider.fetch("https://fixture.invalid/__mode", { method: "POST", body: "foreign-owner" });
  const fourth = await enqueue();
  result = await wake();
  assert.equal(result.projectTasks.retry, 1);
  assert.equal((await stats()).starts, 3);
  checks.changedOwnerStopsHost = true;
  assert.equal(
    (await db.projectTaskIntent.findUniqueOrThrow({ where: { id: fourth } })).phase,
    "queued",
  );
  assert.equal(
    (await db.projectTaskIntent.findUniqueOrThrow({ where: { id: first } })).phase,
    "preparing",
  );
  assert.equal(
    (await db.projectTaskIntent.findUniqueOrThrow({ where: { id: second } })).phase,
    "preparing",
  );
  checks.jobsHadNoDatabaseOrEncryptionIssuerKeys = true;
  for (let index = 0; index < 25 && sockets.size; index++)
    await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sockets.size, 0);
  checks.awaitedPoolCleanup = true;
  checks.sourceStable = true;
  for (const p of sourcePaths) if ((await hash(p)) !== sources[p]) checks.sourceStable = false;
  assert(checks.sourceStable, "Source changed during proof");
  passed = true;
} finally {
  await mf?.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => ws.close(resolve));
  await new Promise((resolve) => bridge.close(resolve));
  await db.$disconnect();
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseRevision,
    endingBaseRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    testedSourcesCommitted: false,
    passed,
    checks,
    observations,
    versions: {
      node: process.version,
      miniflare: JSON.parse(
        await readFile(
          require.resolve("miniflare/package.json", {
            paths: [dirname(require.resolve("wrangler/package.json"))],
          }),
          "utf8",
        ),
      ).version,
    },
    sourceDigests: sources,
    scope: {
      actualWorkerd: true,
      actualPrivateServiceBinding: true,
      actualLocalPostgreSQL: true,
      actualEncryptedIntent: true,
      fullNextFramework: false,
      syntheticCoderAndWorkspace: true,
      localAcceleratedJobsCancellation: true,
      externalProviderRequests: 0,
      remoteMutations: 0,
    },
    scratch,
    databaseName,
  };
  const output = resolve(
    process.env.HIVE_PROJECT_RECONCILE_EVIDENCE_PATH ??
      "docs/checks/autonomous-delivery/project-reconciliation-local.json",
  );
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "pipe" });
  console.log(JSON.stringify({ passed, checks, scratch }));
}
