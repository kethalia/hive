import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const sources = [
  "deploy/cloudflare/app/generic-terminal-relay.ts",
  "deploy/cloudflare/app/generic-terminal-runtime.ts",
  "deploy/cloudflare/app/local-generic-terminal.worker.ts",
  "deploy/cloudflare/app/local-generic-terminal-provider.ts",
  "deploy/cloudflare/app/run-local-generic-terminal.mjs",
  "src/lib/terminal/generic-auth.server.ts",
  "services/terminal-proxy/src/protocol.ts",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(p))
          .digest("hex"),
      ]),
    ),
  );
const before = await hashes();
const directory = await mkdtemp(join(tmpdir(), "hive-generic-terminal-"));
const bearer = randomBytes(32).toString("hex"),
  authSecret = randomBytes(32).toString("hex"),
  cookieSecret = randomBytes(32).toString("hex");
const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const address = portServer.address();
assert(address && typeof address !== "string");
const port = address.port;
await new Promise((r, reject) => portServer.close((e) => (e ? reject(e) : r())));
const origin = `http://127.0.0.1:${port}`;
for (const [name, main, services] of [
  [
    "main",
    "local-generic-terminal.worker.ts",
    [{ binding: "PROVIDER", service: "hive-local-generic-provider" }],
  ],
  ["provider", "local-generic-terminal-provider.ts", []],
]) {
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify({
      name: name === "main" ? "hive-local-generic-terminal" : "hive-local-generic-provider",
      main: resolve("deploy/cloudflare/app", main),
      compatibility_date: "2026-10-30",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      services,
      observability: { enabled: false },
    }),
    { mode: 0o600 },
  );
}
await writeFile(
  join(directory, ".dev.vars"),
  `PROOF_BEARER=${bearer}\nAUTH_SERVICE_SECRET=${authSecret}\nCOOKIE_SECRET=${cookieSecret}\n`,
  { mode: 0o600 },
);
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--config",
    join(directory, "main.json"),
    "--config",
    join(directory, "provider.json"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--log-level",
    "error",
  ],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
let logs = "";
for (const pipe of [child.stdout, child.stderr])
  pipe.on("data", (b) => {
    logs = (logs + b).slice(-1048576);
  });
const exited = new Promise((r) => child.once("exit", r));
const sockets = [];
const checks = {};
const authHeaders = { Authorization: `Bearer ${bearer}` };
const target = `/ws?${new URLSearchParams({ workspaceId: "30000000-0000-4000-8000-000000000001", agentId: "40000000-0000-4000-8000-000000000001", reconnectId: "60000000-0000-4000-8000-000000000001", sessionName: "fixture-shell", width: "80", height: "24" })}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function ticket(path = target, expired = false) {
  const response = await fetch(`${origin}/__local/ticket`, {
    method: "POST",
    headers: { ...authHeaders, ...(expired ? { "X-Local-Expired": "yes" } : {}) },
    body: path,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).ticket;
}
function observe(socket, event, predicate = () => true, timeout = 10000) {
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Local ${event} deadline`));
    }, timeout);
    const done = (...args) => {
      if (!predicate(...args)) return;
      cleanup();
      resolveEvent(args);
    };
    const error = () => {
      cleanup();
      reject(new Error(`Local ${event} socket error`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, done);
      socket.off("error", error);
    };
    socket.on(event, done);
    socket.on("error", error);
  });
}
async function connect(short = false) {
  const socket = new WebSocket(
    `${origin.replace("http:", "ws:")}${target}`,
    ["hive-terminal-v1", `hive-ticket.${await ticket()}`],
    { headers: { Origin: origin, ...(short ? { "X-Local-Short": "yes" } : {}) } },
  );
  sockets.push(socket);
  const ready = observe(
    socket,
    "message",
    (data, binary) => !binary && data.toString() === '{"type":"hive:ready"}',
  );
  await observe(socket, "open");
  await ready;
  assert.equal(socket.protocol, "hive-terminal-v1");
  return socket;
}
async function rejectUpgrade(path, value) {
  const socket = new WebSocket(
    `${origin.replace("http:", "ws:")}${path}`,
    ["hive-terminal-v1", `hive-ticket.${value}`],
    { headers: { Origin: origin } },
  );
  sockets.push(socket);
  socket.on("error", () => {});
  const result = await observe(socket, "unexpected-response");
  assert.equal(result[1].statusCode, 401);
  result[1].resume();
  socket.terminate();
}
let failed,
  processGroupDrained = false;
try {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      if (
        (
          await fetch(`${origin}/__local/off`, {
            headers: authHeaders,
            signal: AbortSignal.timeout(1000),
          })
        ).status === 404
      )
        break;
    } catch {}
    assert(
      Date.now() < deadline && child.exitCode === null && child.signalCode === null,
      "Local workerd startup failed",
    );
    await delay(100);
  }
  checks.defaultOff = true;
  await rejectUpgrade(target, await ticket(target, true));
  checks.expiredAdmissionRejected = true;
  await rejectUpgrade(target.replace("width=80", "width=81"), await ticket());
  checks.targetSubstitutionRejected = true;
  const socket = await connect();
  checks.upgrade = true;
  let message = observe(socket, "message", (data, binary) => binary && data.toString() === "hello");
  socket.send('{"data":"hello"}');
  await message;
  checks.binaryInputOutput = true;
  message = observe(
    socket,
    "message",
    (data, binary) => binary && data.toString() === "resize:40:120",
  );
  socket.send('{"height":40,"width":120}');
  await message;
  checks.resize = true;
  message = observe(
    socket,
    "message",
    (data, binary) => !binary && data.toString() === '{"type":"hive:pong","id":1}',
  );
  socket.send('{"type":"hive:ping","id":1}');
  await message;
  checks.healthControl = true;
  const closed = observe(socket, "close");
  socket.close();
  await closed;
  const next = await connect();
  const status = await (await fetch(`${origin}/__local/status`, { headers: authHeaders })).json();
  assert.equal(status.sessions, 1);
  checks.reconnectSameRemoteId = true;
  const peerClosed = observe(next, "close");
  next.send('{"data":"close"}');
  const peer = await peerClosed;
  assert.equal(peer[0], 1013);
  assert(!peer[1].toString().includes("private"));
  checks.sanitizedClose = true;
  const flood = await connect();
  const flooded = observe(flood, "close");
  flood.send('{"data":"flood"}');
  assert.equal((await flooded)[0], 1013);
  checks.cumulativeOutputBound = true;
  const short = await connect(true);
  assert.equal((await observe(short, "close"))[0], 1013);
  checks.attachmentExpiry = true;
  const revoked = await connect();
  const revokeResult = observe(revoked, "close", () => true, 27000);
  assert.equal((await fetch(`${origin}/__local/revoke`, { headers: authHeaders })).status, 200);
  assert.equal((await revokeResult)[0], 4401);
  checks.currentOwnerRevocation = true;
} catch (error) {
  failed = error instanceof Error ? error.message : "local-proof-failed";
} finally {
  for (const socket of sockets) {
    try {
      socket.terminate();
    } catch {}
  }
  // Never signal a numeric process group after its leader has been reaped.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await exited;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") processGroupDrained = true;
      break;
    }
    await delay(100);
  }
}
const after = await hashes();
const result = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  sourceStable: JSON.stringify(before) === JSON.stringify(after),
  sourceHashes: after,
  checks,
  passed: !failed && processGroupDrained && Object.keys(checks).length === 12,
  processGroupDrained,
  provider: "synthetic private auth/Coder service binding; actual workerd WebSockets",
  cloudMutation: false,
  ...(failed
    ? {
        failure: failed,
        logTail: logs
          .slice(-2000)
          .replaceAll(bearer, "[redacted]")
          .replaceAll(authSecret, "[redacted]")
          .replaceAll(cookieSecret, "[redacted]"),
      }
    : {}),
};
const output = resolve("docs/checks/autonomous-delivery/generic-terminal-local/workerd.json");
await import("node:fs/promises").then(({ mkdir }) =>
  mkdir(resolve("docs/checks/autonomous-delivery/generic-terminal-local"), { recursive: true }),
);
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify({
    passed: result.passed,
    sourceStable: result.sourceStable,
    checks: Object.keys(checks).length,
    evidence: output,
    ...(failed ? { failure: failed } : {}),
  }),
);
assert(
  result.passed && result.sourceStable,
  "Local generic terminal proof failed; sanitized evidence retained",
);
