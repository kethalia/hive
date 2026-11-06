// Fixed loopback-only PostgreSQL/Workerd proof. No remote bindings or provider APIs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as reserveServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

const databaseUrl = process.env.HIVE_AGENT_NOTIFICATION_TEST_DATABASE_URL;
const url = new URL(databaseUrl);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/hive_agent_notification_test");
assert.ok(/^\d+$/.test(url.port));
const directory = await mkdtemp(join(tmpdir(), "hive-agent-notifications-workerd-"));
const bridge = createServer(),
  websockets = new WebSocketServer({ server: bridge, maxPayload: 1048576 }),
  sockets = new Set();
websockets.on("connection", (ws, request) => {
  if (request.url !== "/") {
    ws.close();
    return;
  }
  const socket = connect({ host: "127.0.0.1", port: Number(url.port) });
  sockets.add(socket);
  let bytes = 0;
  const timeout = setTimeout(() => {
    socket.destroy();
    ws.terminate();
  }, 60000);
  ws.on("message", (data) => {
    bytes += data.length;
    if (bytes > 16777216) {
      socket.destroy();
      ws.terminate();
      return;
    }
    socket.write(data);
  });
  socket.on("data", (data) => {
    if (ws.readyState === 1) ws.send(data);
  });
  socket.on("error", () => ws.terminate());
  socket.on("close", () => {
    sockets.delete(socket);
    clearTimeout(timeout);
    ws.close();
  });
  ws.on("close", () => socket.destroy());
  ws.on("error", () => socket.destroy());
});
await new Promise((done) => bridge.listen(0, "127.0.0.1", done));
const reserve = reserveServer();
await new Promise((done) => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const bearer = randomBytes(32).toString("hex"),
  configPath = join(directory, "wrangler.json");
await writeFile(
  configPath,
  JSON.stringify({
    name: "hive-agent-notifications-local-proof",
    main: resolve("deploy/cloudflare/jobs/local-agent-notifications.worker.ts"),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    vars: {
      HIVE_RUNTIME_TARGET: "cloudflare",
      HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED: "true",
      CODER_URL: "https://coder.agent-workerd.invalid",
      WS_PORT: String(bridge.address().port),
    },
  }),
);
await writeFile(
  join(directory, ".dev.vars"),
  `DATABASE_URL=${JSON.stringify(databaseUrl)}\nLOCAL_PROOF_BEARER=${JSON.stringify(bearer)}\n`,
  { mode: 0o600 },
);
const sourcePaths = [
  "packages/db/prisma/schema.prisma",
  "packages/db/prisma/migrations/20261105233000_agent_notification_events/migration.sql",
  "src/lib/push/agent-event-contract.ts",
  "src/app/api/notifications/events/route.ts",
  "src/lib/push/agent-events.ts",
  "src/lib/push/agent-events-route.ts",
  "src/lib/push/durable-outbox.ts",
  "src/lib/push/bounded-send.ts",
  "src/lib/delivery/outbox.ts",
  "deploy/cloudflare/jobs/worker.ts",
  "deploy/cloudflare/jobs/local-agent-notifications.worker.ts",
  "deploy/cloudflare/jobs/run-local-agent-notifications.mjs",
  "packages/db/src/generated/prisma-workerd/client.ts",
  "packages/db/src/generated/prisma-workerd/internal/class.ts",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
const sources = await hashes();
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--config",
    configPath,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--persist-to",
    join(directory, "state"),
    "--show-interactive-dev-session=false",
  ],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  },
);
let logs = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    logs = (logs + chunk).slice(-262144);
  });
const closed = new Promise((done) => child.once("close", done));
const live = () => child.exitCode === null && child.signalCode === null;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (!live()) throw new Error("Local Workerd exited");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__local-agent-notifications`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 404) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.ok(ready, "Local startup deadline");
  const response = await fetch(`http://127.0.0.1:${port}/__local-agent-notifications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    localOnly: true,
    sourceStable: JSON.stringify(sources) === JSON.stringify(await hashes()),
    sources,
    result,
    remoteBindings: false,
    realProviderRequests: 0,
  };
  const output = resolve("docs/checks/autonomous-delivery/agent-notifications-local");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "workerd.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  assert.ok(response.ok && result.passed, `Workerd proof failed at ${result.stage ?? "unknown"}`);
  assert.ok(evidence.sourceStable, "Sources changed during proof");
  console.log(JSON.stringify({ passed: true, checks: result.checks }));
} finally {
  await writeFile(join(directory, "private-runtime.log"), logs, { mode: 0o600 });
  if (live()) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await Promise.race([closed, new Promise((done) => setTimeout(done, 3000))]);
  if (live()) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  for (const socket of sockets) socket.destroy();
  for (const ws of websockets.clients) ws.terminate();
  await new Promise((done) => websockets.close(done));
  await new Promise((done) => bridge.close(done));
}
