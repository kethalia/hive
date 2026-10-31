import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "hive-rotation-workerd-")),
  bearer = randomBytes(32).toString("hex");
const server = createServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const config = {
  name: "hive-rotation-local-proof",
  main: resolve("deploy/cloudflare/auth/local-rotation.worker.ts"),
  compatibility_date: "2026-10-30",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  workers_dev: false,
  preview_urls: false,
  vars: {
    HIVE_RUNTIME_TARGET: "cloudflare",
    CODER_URL: "https://coder.rotation-proof.invalid",
    HIVE_TOKEN_ROTATION_ENABLED: "false",
  },
};
await writeFile(join(directory, "wrangler.json"), JSON.stringify(config), { mode: 0o600 });
await writeFile(
  join(directory, ".dev.vars"),
  `PROOF_BEARER=${JSON.stringify(bearer)}\nENCRYPTION_KEY=${JSON.stringify("a".repeat(64))}\n`,
  { mode: 0o600 },
);
const sourcePaths = [
  "services/auth/src/auth/rotation-scheduler.ts",
  "services/auth/src/auth/rotation-store.ts",
  "services/auth/src/auth/rotation-contracts.ts",
  "services/auth/src/auth/bounded-coder-json.ts",
  "deploy/cloudflare/auth/local-rotation.worker.ts",
  "deploy/cloudflare/auth/run-local-rotation.mjs",
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
const before = await hashes();
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--config",
    join(directory, "wrangler.json"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--persist-to",
    join(directory, "state"),
  ],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
const closed = new Promise((done) => child.once("close", done));
let logs = "";
child.stdout.on("data", (v) => {
  logs += v;
});
child.stderr.on("data", (v) => {
  logs += v;
});
const live = () => child.pid && child.exitCode === null && child.signalCode === null;
try {
  const until = Date.now() + 60000;
  while (!logs.includes("Ready on")) {
    if (!live() || Date.now() > until) throw new Error("rotation_workerd_startup_failed");
    await new Promise((done) => setTimeout(done, 100));
  }
  const response = await fetch(`http://127.0.0.1:${port}/__local-rotation`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  const sourceStable = JSON.stringify(before) === JSON.stringify(await hashes());
  if (!response.ok || !result.ok || !sourceStable) throw new Error("rotation_workerd_proof_failed");
  const evidence = {
    observedAt: new Date().toISOString(),
    result,
    sourceStable,
    sourceSha256: before,
    externalRequests: 0,
    realDatabase: false,
    remoteProviderProof: false,
    productionActivation: false,
  };
  const output = "docs/checks/autonomous-delivery/token-rotation-local";
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "workerd.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, checks: result.checks, externalRequests: 0 }));
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
  await Promise.race([closed, new Promise((done) => setTimeout(done, 3000))]);
  let absent = false;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    absent = error.code === "ESRCH";
  }
  if (absent) await rm(directory, { recursive: true, force: true });
  else
    console.log(
      JSON.stringify({
        held: true,
        reason: "local_runtime_group_uncertain",
        privateDirectory: directory,
      }),
    );
}
