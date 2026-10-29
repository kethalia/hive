import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const credentialDirectory =
  process.env.HIVE_PREVIEW_CREDENTIAL_DIRECTORY ?? "/tmp/hive-epic-coder-auth";
const output = join(directory, "prisma-workerd-evidence.json");
const varsFile = join(directory, ".dev.vars");
const port = 8791;
const origin = `http://127.0.0.1:${port}`;
const sources = [
  "worker.mjs",
  "worker-core.mjs",
  "prisma-probe.mjs",
  "prisma/schema.prisma",
  "package.json",
  "pnpm-lock.yaml",
  "wrangler.jsonc",
  "run-local-proof.mjs",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
let child;
let ownsVars = false;
try {
  const baseRevision = git("rev-parse", "HEAD");
  const changed = git("status", "--porcelain", "--", ...sources);
  const allowUncommitted = process.argv.includes("--allow-uncommitted");
  assert.ok(!changed || allowUncommitted, "Commit the tested source before running this proof");
  const fileDigests = {};
  for (const source of sources)
    fileDigests[source] = sha256(await readFile(join(directory, source)));
  const url = (await readFile(join(credentialDirectory, "neon-preview-probe-url"), "utf8")).trim();
  const coderToken = (await readFile(join(credentialDirectory, "session"), "utf8")).trim();
  const bearer = randomBytes(32).toString("base64url");
  const runId = randomUUID();
  const bindings = {
    CODER_URL: "https://coder.kethalia.com",
    SOURCE_REVISION: baseRevision,
    PROBE_RUN_ID: runId,
    NEON_PREVIEW_BRANCH_ID: "br-ancient-violet-b7pcun87",
    NEON_PREVIEW_HOST: new URL(url).hostname,
    DATABASE_URL: url,
    PREVIEW_BEARER_TOKEN: bearer,
    CODER_API_TOKEN: coderToken,
  };
  await writeFile(
    varsFile,
    Object.entries(bindings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
      .join(""),
    { flag: "wx", mode: 0o600 },
  );
  ownsVars = true;
  execFileSync("pnpm", ["generate"], { cwd: directory, stdio: "ignore" });
  child = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port)],
    {
      cwd: directory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local workerd startup timed out")), 20_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Local workerd failed to start"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Local workerd exited"));
    });
    let log = "";
    child.stdout.on("data", (chunk) => {
      log = (log + chunk.toString()).slice(-4096);
      if (log.includes(`Ready on ${origin}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const results = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    const result = await fetch(`${origin}/api/probe/prisma`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(55_000),
    });
    const body = await result.json();
    assert.equal(result.status, 200);
    assert.equal(body.runId, runId);
    assert.equal(body.sourceRevision, baseRevision);
    assert.equal(body.prisma.runtimeRoleRestricted, true);
    assert.equal(body.prisma.insertedThisRun, attempt === 0);
    assert.equal(body.prisma.retainedRowsForRun, 1);
    assert.equal(body.prisma.rollback, true);
    results.push({
      status: result.status,
      elapsedMs: Math.round(performance.now() - started),
      body,
    });
  }
  for (const source of sources)
    assert.equal(
      sha256(await readFile(join(directory, source))),
      fileDigests[source],
      "Source changed during proof",
    );
  const artifact = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    runtime: "local-workerd-real-neon",
    sourceBaseRevision: baseRevision,
    testedSourceCommitted: !changed,
    sourceRevisionResponseMeaning: changed
      ? "base revision only; exact tested files bound below"
      : "committed source revision",
    fileDigests,
    sourceSetDigest: sha256(JSON.stringify(fileDigests)),
    projectId: "purple-math-59583745",
    branchId: bindings.NEON_PREVIEW_BRANCH_ID,
    runId,
    databaseCredential: "restricted-runtime-role, owner URL unused",
    requests: results,
    cloudflareDeployed: false,
    f02Complete: false,
    limitations: [
      "fixture schema only",
      "full Hive schema not verified",
      "framework and Hive auth not verified",
      "not Cloudflare network execution",
    ],
  };
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: true,
      artifact: output,
      runId,
      testedSourceCommitted: !changed,
      sourceSetDigest: artifact.sourceSetDigest,
    }),
  );
} catch {
  console.error("Local Prisma workerd proof failed. No credentials or raw driver errors printed.");
  process.exitCode = 1;
} finally {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  if (ownsVars) await unlink(varsFile);
}
