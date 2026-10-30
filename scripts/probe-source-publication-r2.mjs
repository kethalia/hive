import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const paths = [
  "src/lib/delivery/source-transport.server.ts",
  "src/lib/delivery/source-transport-contracts.ts",
  "src/lib/delivery/source-publication.server.ts",
  "src/lib/delivery/github-artifacts.server.ts",
  "src/__tests__/lib/delivery/source-transport.integration.test.ts",
  "deploy/cloudflare/evidence/local-r2-fixture.ts",
  "scripts/probe-source-publication-r2.mjs",
];
const sources = Object.fromEntries(
  await Promise.all(
    paths.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
    ]),
  ),
);
const directory = await mkdtemp(join(tmpdir(), "hive-local-r2-proof-")),
  bearer = randomBytes(32).toString("hex");
const config = join(directory, "wrangler.json");
await writeFile(
  config,
  JSON.stringify({
    name: "hive-local-evidence-proof",
    main: join(root, "deploy/cloudflare/evidence/local-r2-fixture.ts"),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    r2_buckets: [{ binding: "HIVE_DELIVERY_EVIDENCE", bucket_name: "hive-local-evidence-test" }],
  }),
  { mode: 0o600 },
);
await writeFile(join(directory, ".dev.vars"), `LOCAL_PROOF_BEARER=${bearer}\n`, { mode: 0o600 });
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let child;
async function stop() {
  if (!child) return;
  const current = child;
  child = null;
  try {
    process.kill(-current.pid, "SIGTERM");
  } catch {}
  await new Promise((resolve) => {
    if (current.exitCode !== null || current.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        process.kill(-current.pid, "SIGKILL");
      } catch {}
      resolve();
    }, 3000);
    current.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function start() {
  let log = "";
  child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--config",
      config,
      "--persist-to",
      join(directory, "state"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  child.stdout.on("data", (chunk) => {
    log = (log + chunk.toString()).slice(-20000);
  });
  child.stderr.on("data", (chunk) => {
    log = (log + chunk.toString()).slice(-20000);
  });
  const deadline = Date.now() + 30000;
  while (!log.includes(`Ready on ${origin}`)) {
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error("Local R2 workerd startup failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function request(caseId, operation, authenticated = true) {
  const response = await fetch(origin, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ caseId, operation }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: response.status === 403 ? null : await response.json() };
}
try {
  await start();
  const id = randomUUID();
  assert.equal((await request(id, "store", false)).status, 403);
  const first = await request(id, "store");
  assert.equal(first.status, 200);
  for (const replay of await Promise.all(Array.from({ length: 8 }, () => request(id, "store"))))
    assert.deepEqual(replay, first);
  assert.deepEqual((await request(id, "inspect")).body, {
    count: 1,
    truncated: false,
    digest: first.body.contentDigest,
  });
  await stop();
  await start();
  assert.deepEqual(await request(id, "store"), first);
  assert.equal((await request(id, "inspect")).body.count, 1);
  let postgresIntegration = "not requested";
  if (process.env.HIVE_DELIVERY_TEST_DATABASE_URL) {
    const output = execFileSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--no-file-parallelism",
        "src/__tests__/lib/delivery/source-transport.integration.test.ts",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          HIVE_LOCAL_R2_PROOF_ORIGIN: origin,
          HIVE_LOCAL_R2_PROOF_BEARER: bearer,
        },
      },
    );
    assert.ok(output.includes("12 passed"));
    postgresIntegration =
      "passed: signed source issuer/publication protocol + injected admission + real PG + actual local workerd R2 binding";
  }
  await request(id, "corrupt");
  assert.deepEqual(await request(id, "store"), {
    status: 409,
    body: { error: "github_artifact_unverified" },
  });
  const corrupted = (await request(id, "inspect")).body;
  assert.equal(corrupted.count, 1);
  assert.notEqual(corrupted.digest, first.body.contentDigest);
  const after = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      ]),
    ),
  );
  assert.deepEqual(after, sources);
  const evidence = {
    observedAt: new Date().toISOString(),
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceStable: true,
    sourceSha256: sources,
    checks: [
      "unauthenticated loopback denied",
      "real local R2 conditional create+SHA256+streamed readback",
      "eight concurrent exact replays retain one object",
      "workerd restart preserves object",
      "same-key corrupted bytes rejected and preserved",
    ],
    remoteWrites: false,
    liveR2Proof: false,
    installedBundleProof: false,
    realGuardianProof: false,
    realProviderProof: false,
    postgresIntegration,
    scope:
      "Actual local workerd R2 emulator only; no Cloudflare bucket or billing change; retention lock/IAM requires separate deployment review.",
  };
  const output = process.env.HIVE_R2_PROOF_OUTPUT;
  if (output) await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
