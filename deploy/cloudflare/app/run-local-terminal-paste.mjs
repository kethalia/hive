import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sources = [
  "deploy/cloudflare/app/terminal-paste-transport.ts",
  "deploy/cloudflare/app/terminal-paste-runtime.ts",
  "deploy/cloudflare/app/generic-terminal-runtime.ts",
  "deploy/cloudflare/app/local-terminal-paste.worker.ts",
  "deploy/cloudflare/app/local-terminal-paste-provider.ts",
  "deploy/cloudflare/app/local-generic-terminal-provider.ts",
  "deploy/cloudflare/app/run-local-terminal-paste.mjs",
  "src/lib/workspace/paste-writer.ts",
  "src/lib/workspace/paste-request.ts",
  "src/lib/terminal/generic-auth.server.ts",
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
const directory = await mkdtemp(join(tmpdir(), "hive-terminal-paste-"));
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
    "local-terminal-paste.worker.ts",
    [{ binding: "PROVIDER", service: "hive-local-generic-provider" }],
  ],
  ["provider", "local-terminal-paste-provider.ts", []],
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
const checks = {};
const authHeaders = { Authorization: `Bearer ${bearer}` };
const path = "/api/workspaces/30000000-0000-4000-8000-000000000001/terminal/paste-assets";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie;
async function upload(files, extra = {}) {
  const form = new FormData();
  for (const [name, bytes] of files) form.append("files", new Blob([bytes]), name);
  return fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, ...extra },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
}
async function control(name, body) {
  const res = await fetch(origin + name, {
    method: body === undefined ? "GET" : "POST",
    headers: authHeaders,
    body,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(res.status, 200);
  return res.json();
}
let failed,
  processGroupDrained = false;
try {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      if (
        (
          await fetch(`${origin}/__paste/off`, {
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
  cookie = (await control("/__paste/cookie")).cookie;
  const bytes = Buffer.from(Array.from({ length: 50000 }, (_, i) => i % 256));
  let res = await upload([
    ["test.bin", bytes],
    ["empty.txt", Buffer.alloc(0)],
  ]);
  assert.equal(res.status, 200);
  const paths = (await res.json()).paths;
  assert.equal(paths.length, 2);
  assert(paths.every((p) => /^\/tmp\/hive-terminal-paste\/[a-f0-9-]{36}-/.test(p)));
  let state = await control("/__paste/state");
  assert.equal(state.attempts, 1);
  assert.equal(state.completed, 1);
  assert.deepEqual(
    state.accepted.map((x) => x.size),
    [bytes.length, 0],
  );
  assert.equal(state.accepted[0].sha256, createHash("sha256").update(bytes).digest("hex"));
  checks.binaryExactDigestAndEmptyFile = true;
  checks.actualPrivateAuthAndOwner = true;
  const maximum = Buffer.alloc(10 * 1024 * 1024, 0x5a);
  res = await upload([
    ["maximum-a.bin", maximum],
    ["maximum-b.bin", maximum],
  ]);
  assert.equal(res.status, 200);
  state = await control("/__paste/state");
  assert.equal(state.attempts, 2);
  assert.equal(state.completed, 2);
  assert.deepEqual(
    state.accepted.slice(-2).map((x) => x.size),
    [maximum.length, maximum.length],
  );
  assert(
    state.accepted
      .slice(-2)
      .every((x) => x.sha256 === createHash("sha256").update(maximum).digest("hex")),
  );
  checks.exact20MiBContract = true;
  assert.equal(
    (await upload([["bad.bin", bytes]], { Origin: "https://other.example" })).status,
    403,
  );
  checks.originRejected = true;
  assert.equal((await upload([["bad.bin", bytes]], { Cookie: "" })).status, 401);
  checks.sessionRequired = true;
  await control("/__paste/mode", "wrong-path");
  res = await upload([["lost.bin", bytes]]);
  assert.equal(res.status, 502);
  state = await control("/__paste/state");
  assert.equal(state.attempts, 3);
  checks.mismatchedAckNoRetry = true;
  await control("/__paste/mode", "close");
  res = await upload([["unknown.bin", bytes]]);
  assert.equal(res.status, 502);
  state = await control("/__paste/state");
  assert.equal(state.attempts, 4);
  checks.lostAckUnknownNoRetry = true;
  await control("/__local/revoke");
  res = await upload([["revoked.bin", bytes]]);
  assert.notEqual(res.status, 200);
  state = await control("/__paste/state");
  assert.equal(state.attempts, 4);
  checks.revokedBeforeEffect = true;
} catch (error) {
  failed = error instanceof Error ? error.message : "local-proof-failed";
} finally {
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
  passed: !failed && processGroupDrained && Object.keys(checks).length === 9,
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
const output = resolve("docs/checks/autonomous-delivery/terminal-paste-local/workerd.json");
await import("node:fs/promises").then(({ mkdir }) =>
  mkdir(resolve("docs/checks/autonomous-delivery/terminal-paste-local"), { recursive: true }),
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
  "Local terminal paste proof failed; sanitized evidence retained",
);
