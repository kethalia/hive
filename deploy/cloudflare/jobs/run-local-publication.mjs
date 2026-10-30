import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { templateArtifact } from "../../../scripts/build-template-artifacts.mjs";

const directory = await mkdtemp(join(tmpdir(), "hive-publication-workerd-"));
const creationMode = process.argv.includes("--creation");
const fixture = JSON.parse(
  await readFile(
    creationMode ? "/tmp/hive-template-creation-fixture.json" : "/tmp/hive-template-fixture.json",
    "utf8",
  ),
);
const parsed = new URL(fixture.url);
if (
  parsed.hostname !== "127.0.0.1" ||
  parsed.pathname !== "/hive_template_test" ||
  parsed.port !== String(fixture.port)
)
  throw new Error("Local task-owned PostgreSQL required");
const databaseName = `hive_template_workerd_${randomBytes(6).toString("hex")}`;
execFileSync(
  "/usr/lib/postgresql/17/bin/createdb",
  ["-h", "127.0.0.1", "-p", String(fixture.port), databaseName],
  { stdio: "pipe" },
);
const databaseUrl = `postgresql://coder@127.0.0.1:${fixture.port}/${databaseName}?sslmode=disable`;
execFileSync("pnpm", ["--filter", "@hive/db", "exec", "prisma", "migrate", "deploy"], {
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "pipe",
});
const templateRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const templateExport = join(directory, "template-source");
await mkdir(templateExport);
execFileSync("tar", ["-xf", "-", "-C", templateExport], {
  input: execFileSync("git", ["archive", templateRevision, "templates/ai-dev-k8s"], {
    maxBuffer: 16 * 1024 * 1024,
  }),
});
const artifact = await templateArtifact(join(templateExport, "templates/ai-dev-k8s"));
const manifest = JSON.parse(await readFile("src/lib/templates/artifact-manifest.json", "utf8"));
if (
  JSON.stringify(manifest) !==
  JSON.stringify(
    JSON.parse(
      execFileSync(
        "git",
        ["show", `${templateRevision}:src/lib/templates/artifact-manifest.json`],
        { encoding: "utf8" },
      ),
    ),
  )
)
  throw new Error("Working artifact manifest differs from selected committed template source");
if (JSON.stringify(artifact.metadata) !== JSON.stringify(manifest.templates["ai-dev-k8s"]))
  throw new Error(
    "Canonical artifact manifest must already be current; proof never regenerates it",
  );
const assets = join(directory, "assets");
await mkdir(join(assets, "hive-template-artifacts"), { recursive: true });
await writeFile(
  join(assets, "hive-template-artifacts", `${artifact.metadata.archiveDigest}.tar`),
  artifact.archive,
);
const upstreams = new Set(),
  bridge = createServer(),
  websockets = new WebSocketServer({ server: bridge, maxPayload: 1048576 });
const bridgeStats = {
  connections: 0,
  messages: 0,
  receivedBytes: 0,
  sentBytes: 0,
  socketErrors: 0,
};
websockets.on("connection", (ws, request) => {
  bridgeStats.connections++;
  if (request.url !== "/") {
    ws.close();
    return;
  }
  const socket = connect({ host: "127.0.0.1", port: fixture.port });
  upstreams.add(socket);
  let bytes = 0;
  const timeout = setTimeout(() => {
    socket.destroy();
    ws.terminate();
  }, 120000);
  ws.on("message", (data) => {
    bridgeStats.messages++;
    bridgeStats.receivedBytes += data.length;
    bytes += data.length;
    if (bytes > 16777216) {
      socket.destroy();
      ws.terminate();
      return;
    }
    socket.write(data);
  });
  socket.on("data", (data) => {
    bridgeStats.sentBytes += data.length;
    if (ws.readyState === 1) ws.send(data);
  });
  socket.on("error", () => {
    bridgeStats.socketErrors++;
    ws.terminate();
  });
  socket.on("close", () => {
    upstreams.delete(socket);
    clearTimeout(timeout);
    ws.close();
  });
  ws.on("close", () => socket.destroy());
  ws.on("error", () => socket.destroy());
});
await new Promise((done) => bridge.listen(0, "127.0.0.1", done));
const wsPort = bridge.address().port;
const reserve = tcpServer();
await new Promise((done) => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const bearer = randomBytes(32).toString("hex"),
  secret = randomBytes(32).toString("hex"),
  owner = randomUUID(),
  coder = randomUUID(),
  session = randomUUID();
const vars = {
  HIVE_RUNTIME_TARGET: "cloudflare",
  CODER_URL: "https://coder.publication-proof.invalid",
  HIVE_TEMPLATE_PUBLICATION_ENABLED: "false",
  CREATION_PROOF: String(creationMode),
  WS_PORT: String(wsPort),
  OWNER_ID: owner,
  CODER_USER_ID: coder,
  SESSION_ID: session,
};
const base = {
  compatibility_date: "2026-10-30",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  preview_urls: false,
  vars,
};
const configs = [
  {
    ...base,
    name: "hive-publication-local-proof",
    main: resolve("deploy/cloudflare/jobs/local-publication.worker.ts"),
    assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
    services: [
      { binding: "AUTH_SERVICE", service: "hive-publication-local-fixture" },
      { binding: "CODER", service: "hive-publication-local-fixture" },
    ],
  },
  {
    ...base,
    name: "hive-publication-local-fixture",
    main: resolve("deploy/cloudflare/jobs/local-publication-fixture.worker.ts"),
  },
];
const configPaths = [];
for (let i = 0; i < configs.length; i++) {
  const path = join(directory, `worker-${i}.json`);
  await writeFile(path, JSON.stringify(configs[i]), { mode: 0o600 });
  configPaths.push(path);
}
await writeFile(
  join(directory, ".dev.vars"),
  `DATABASE_URL=${JSON.stringify(databaseUrl)}\nPROOF_BEARER=${JSON.stringify(bearer)}\nAUTH_SERVICE_SECRET=${JSON.stringify(secret)}\n`,
  { mode: 0o600 },
);
const sourcePaths = [
  ...(creationMode
    ? [
        "packages/db/prisma/migrations/20261029170000_template_publication_creation/migration.sql",
        "src/lib/templates/publication-tags.ts",
      ]
    : []),
  "packages/db/prisma/schema.prisma",
  "packages/db/prisma/migrations/20261029160000_template_publication/migration.sql",
  "src/lib/templates/publication-actor.ts",
  "src/lib/templates/publication-artifact.ts",
  "src/lib/templates/publication-contracts.ts",
  "src/lib/templates/publication-factory.ts",
  "src/lib/templates/publication-io.ts",
  "src/lib/templates/publication-provider.ts",
  "src/lib/templates/publication-routes.ts",
  "src/lib/templates/publication-service.ts",
  "src/lib/templates/publication-store.ts",
  "src/lib/templates/push-route.node.ts",
  "src/lib/templates/push-stream-route.node.ts",
  "src/app/api/templates/[name]/push/route.ts",
  "src/app/api/templates/[name]/push/[jobId]/stream/route.ts",
  "src/__tests__/lib/templates/publication.test.ts",
  "src/__tests__/lib/templates/publication.integration.test.ts",
  "src/lib/templates/artifact-manifest.json",
  "deploy/cloudflare/jobs/template-publications.ts",
  "deploy/cloudflare/jobs/worker.ts",
  "deploy/cloudflare/jobs/local-publication.worker.ts",
  "deploy/cloudflare/jobs/local-publication-fixture.worker.ts",
  "deploy/cloudflare/jobs/run-local-publication.mjs",
  "packages/db/src/cloudflare.ts",
  "packages/db/src/generated/prisma-workerd/client.ts",
  "packages/db/src/generated/prisma-workerd/internal/class.ts",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(p))
          .digest("hex"),
      ]),
    ),
  );
const sources = await hashes();
const args = [
  "exec",
  "wrangler",
  "dev",
  "--local",
  ...configPaths.flatMap((path) => ["--config", path]),
  "--ip",
  "127.0.0.1",
  "--port",
  String(port),
  "--inspector-port",
  "0",
  "--persist-to",
  join(directory, "state"),
  "--show-interactive-dev-session=false",
];
const child = spawn("pnpm", args, {
  cwd: process.cwd(),
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
});
let logs = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    logs = (logs + chunk).slice(-262144);
  });
const closed = new Promise((done) => child.once("close", done)),
  live = () => child.exitCode === null && child.signalCode === null;
let result;
try {
  let ready = false;
  for (let n = 0; n < 150; n++) {
    if (!live()) throw new Error("Local workerd exited");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__local-publication`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 404) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  if (!ready) throw new Error("Local workerd startup deadline");
  const response = await fetch(`http://127.0.0.1:${port}/__local-publication`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(120000),
  });
  result = await response.json();
  await writeFile(join(directory, "private-result.json"), JSON.stringify({ result, bridgeStats }), {
    mode: 0o600,
  });
  if (!response.ok || !result.passed)
    throw new Error(`Local publication proof failed at ${result.stage ?? "unknown"}`);
  const output = creationMode
    ? "docs/checks/autonomous-delivery/template-publication-creation-local"
    : "docs/checks/autonomous-delivery/template-publication-local";
  await mkdir(output, { recursive: true });
  const evidence = {
    observedAt: new Date().toISOString(),
    localOnly: true,
    sourceStable: JSON.stringify(sources) === JSON.stringify(await hashes()),
    sources,
    result,
    readOnlyHttp404: true,
    transport:
      "local workerd full PrismaNeon client through fixed loopback-only WebSocket to real local PostgreSQL",
    remoteBindings: false,
    realProviderRequests: 0,
    artifactDigest: artifact.metadata.archiveDigest,
    databaseName,
    templateRevision,
  };
  await writeFile(join(output, "workerd.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({ passed: true, sourceStable: evidence.sourceStable, checks: result.checks }),
  );
} finally {
  await writeFile(join(directory, "private-runtime.log"), logs, { mode: 0o600 });
  if (live())
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  await Promise.race([closed, new Promise((done) => setTimeout(done, 3000))]);
  if (live())
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  await Promise.race([closed, new Promise((done) => setTimeout(done, 3000))]);
  for (const socket of upstreams) socket.destroy();
  for (const ws of websockets.clients) ws.terminate();
  await new Promise((done) => websockets.close(done));
  await new Promise((done) => bridge.close(done));
  let absent = false;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    absent = error.code === "ESRCH";
  }
  if (absent && result?.passed) await rm(directory, { recursive: true, force: true });
  else if (!absent)
    console.log(
      JSON.stringify({
        held: true,
        reason: "local_runtime_group_uncertain",
        privateDirectory: directory,
      }),
    );
  if (!result?.passed) console.error(`Private local failure diagnostics retained: ${directory}`);
}
