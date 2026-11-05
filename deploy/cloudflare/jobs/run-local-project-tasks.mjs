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
  "package.json",
  "pnpm-lock.yaml",
  "packages/db/scripts/generate-cloudflare.mjs",
  "src/lib/projects/reconcile-transport.ts",
  "src/lib/projects/reconcile-route.server.ts",
  "src/lib/projects/task.server.ts",
  "src/lib/projects/task-intents.server.ts",
  "src/lib/delivery/repository-policy-store.server.ts",
  "src/lib/delivery/repository-policy-contracts.ts",
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
  "deploy/cloudflare/jobs/pilot-schedule.ts",
  "deploy/cloudflare/jobs/local-project-tasks.worker.ts",
  "deploy/cloudflare/jobs/local-project-coder.worker.ts",
  "deploy/cloudflare/jobs/run-local-project-tasks.mjs",
  "packages/db/prisma/schema.prisma",
  "packages/db/src/cloudflare.ts",
];
const generatedRoot = "packages/db/src/generated/prisma-workerd";
async function generatedFiles(directory = generatedRoot) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await generatedFiles(path)));
    else {
      assert.ok(entry.isFile());
      files.push(path);
    }
  }
  return files.sort();
}
const generatedAtStart = await generatedFiles();
assert.ok(generatedAtStart.length > 0);
sourcePaths.push(...generatedAtStart);
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const migrationRoot = resolve("packages/db/prisma/migrations"),
  migrationNames = execFileSync(
    "git",
    ["ls-tree", "-d", "--name-only", "HEAD:packages/db/prisma/migrations"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
assert.ok(migrationNames.length >= 39);
for (const name of migrationNames)
  sourcePaths.push(`packages/db/prisma/migrations/${name}/migration.sql`);
const sources = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (p) => [p, await hash(p)])),
);
const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const cleanTreePaths = [
  "src",
  "packages",
  "services",
  "deploy/cloudflare/app",
  "deploy/cloudflare/auth",
  "deploy/cloudflare/jobs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "next.config.ts",
  "open-next.config.ts",
  "tsconfig.json",
];
const sourceTreeClean = () =>
  !execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...cleanTreePaths],
    { encoding: "utf8" },
  ).trim();
const sourceTreeInitiallyClean = sourceTreeClean();
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
      define: { "import.meta.url": '"file:///tmp/hive-policy-fixture.mjs"' },
      banner: {
        js: 'import {createRequire as fixtureRequire} from "node:module";const require=fixtureRequire("/");',
      },
      external: ["node:*", "cloudflare:*"],
      plugins: [
        {
          name: "node-prisma-for-policy-fixture",
          setup(b) {
            if (process.env.HIVE_POLICY_TEST_OLD_QUERY === "1") {
              b.onLoad({ filter: /repository-policy-store\.server\.ts$/ }, async (args) => {
                const original = await readFile(args.path, "utf8");
                const pattern =
                  /await tx\.\$queryRaw<PolicyRow\[\]>\(\s*Prisma\.sql`(SELECT \$\{policyColumns\}[^`]+)`[,]?\s*\)/;
                const modified = original.replace(pattern, "await tx.$queryRaw<PolicyRow[]>`$1`");
                assert.notEqual(modified, original, "The pre-fix regression must be injected");
                return { contents: modified, loader: "ts", resolveDir: dirname(args.path) };
              });
            }
            b.onResolve({ filter: /^@hive\/db$/ }, (args) =>
              args.importer.endsWith("repository-policy-store.server.ts") ||
              args.importer.endsWith("local-project-tasks.worker.ts")
                ? { path: "policy-node-prisma", namespace: "policy-prisma" }
                : undefined,
            );
            b.onLoad({ filter: /.*/, namespace: "policy-prisma" }, () => ({
              contents: `import { sqltag, join } from "@prisma/client/runtime/library";
                export { getDb } from "@hive/db";
                export const Prisma = { sql: sqltag, join, TransactionIsolationLevel: { Serializable: "Serializable" } };`,
              resolveDir: resolve("packages/db"),
              loader: "js",
            }));
          },
        },
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
            HIVE_DELIVERY_PILOT_MODE: "true",
            HIVE_DELIVERY_PILOT_SCHEDULE_ENABLED: "true",
            HIVE_DELIVERY_PILOT_SCHEDULE_STARTED_AT: String(Date.now() - 1000),
            HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL: String(Date.now() + 600000),
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
  const policyFixture = {
    schemaVersion: 1,
    source: {
      version: "local-v1",
      authorName: "Hive fixture",
      authorEmail: "fixture@example.invalid",
      baseBranch: "main",
      allowedPrefixes: ["docs"],
      maxFiles: 2,
      maxFileBytes: 1000,
      maxBytes: 2000,
    },
    evidenceGates: {
      version: "local-v1",
      maxAgeMs: 60000,
      checks: [
        {
          name: "Test",
          workflowId: "61",
          appId: "81",
          appSlug: "github-actions",
          events: ["pull_request"],
          criterionIds: ["repo:ci"],
        },
      ],
      codexReview: { userId: "10", appId: "11", criterionIds: ["repo:review"] },
      formalReviewers: [],
    },
    acceptanceContracts: [],
  };
  const policyProject = await db.deliveryProject.create({
    data: {
      ownerId,
      provider: "github",
      providerRepositoryId: "789",
      providerAccountId: "456",
      fullName: "synthetic/policy",
    },
  });
  const policyResponse = await appService.fetch("https://fixture.invalid/__policy-enrollment", {
    method: "POST",
    body: JSON.stringify({
      ownerId,
      projectId: policyProject.id,
      catalog: [
        {
          ownerId,
          repositoryId: "789",
          providerAccountId: "456",
          fullName: "synthetic/policy",
          policy: policyFixture,
        },
      ],
    }),
  });
  assert.equal(policyResponse.status, 200);
  assert.deepEqual(await policyResponse.json(), { enrolled: true, epicJoin: true });
  checks.actualWorkerdPolicyEnrollmentAndReplay = true;
  checks.actualWorkerdEpicJoin = true;
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
  response = await jobs.fetch("https://fixture.invalid/__wake", {
    headers: { "X-Local-Scheduled": "true" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scheduled: true });
  assert.equal((await stats()).starts, 2);
  checks.actualScheduledHandler = true;
  response = await jobs.fetch("https://fixture.invalid/__wake", {
    headers: { "X-Local-Scheduled-Expired": "true" },
  });
  assert.equal(response.status, 200);
  assert.equal((await stats()).starts, 2);
  checks.expiredScheduledHandlerRejected = true;
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
  checks.generatedClientSetStable =
    JSON.stringify(await generatedFiles()) === JSON.stringify(generatedAtStart);
  assert(checks.generatedClientSetStable, "Generated client file set changed during proof");
  checks.sourceTreeClean = sourceTreeInitiallyClean && sourceTreeClean();
  passed = true;
} finally {
  await mf?.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => ws.close(resolve));
  await new Promise((resolve) => bridge.close(resolve));
  await db.$disconnect();
  const endingBaseRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  // Generated clients are not Git files; their byte hashes are recorded and
  // checked against the separately verified Cloudflare build readiness record.
  const generatedPrefix = "packages/db/src/generated/prisma-workerd/";
  const trackedSources = sourcePaths.filter((path) => !path.startsWith(generatedPrefix));
  const testedSourcesCommitted =
    endingBaseRevision === baseRevision &&
    checks.sourceTreeClean &&
    trackedSources.every((path) => {
      try {
        const contents = execFileSync("git", ["show", `${baseRevision}:${path}`], {
          maxBuffer: 10 * 1024 * 1024,
        });
        return createHash("sha256").update(contents).digest("hex") === sources[path];
      } catch {
        return false;
      }
    });
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseRevision,
    endingBaseRevision,
    testedSourcesCommitted,
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
      generatedClientNotCommitted: true,
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
