// Exercises the actual template hashing implementation in local workerd only.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tar from "tar-stream";
import { templateArtifact, templateNames } from "../../../scripts/build-template-artifacts.mjs";

const directory = await mkdtemp(join(tmpdir(), "hive-template-workerd-"));
const bearer = randomBytes(32).toString("hex");
const paths = [
  "src/lib/templates/staleness.ts",
  "src/lib/templates/artifact-manifest.json",
  "scripts/build-template-artifacts.mjs",
  "deploy/cloudflare/templates/local-comparison-fixture.ts",
  "deploy/cloudflare/templates/run-local-comparison.mjs",
  "pnpm-lock.yaml",
];
const digest = async () =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(p))
          .digest("hex"),
      ]),
    ),
  );
const before = await digest();
const manifest = JSON.parse(await readFile(paths[1], "utf8"));
const templateRoot = resolve(process.env.HIVE_TEMPLATE_PROOF_ROOT || process.cwd());
const artifacts = await Promise.all(
  templateNames.map(async (name) => ({
    name,
    ...(await templateArtifact(join(templateRoot, "templates", name))),
  })),
);
for (const item of artifacts) assert.deepEqual(item.metadata, manifest.templates[item.name]);
await writeFile(
  join(directory, "wrangler.json"),
  JSON.stringify({
    name: "hive-local-template-comparison",
    main: resolve(paths[3]),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    vars: { HIVE_RUNTIME_TARGET: "cloudflare" },
  }),
  { mode: 0o600 },
);
await writeFile(join(directory, ".dev.vars"), `PROOF_BEARER=${bearer}\n`, { mode: 0o600 });
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
    "0",
    "--inspector-port",
    "0",
  ],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
let log = "";
child.stdout.on("data", (b) => {
  log += b;
});
child.stderr.on("data", (b) => {
  log += b;
});
const results = [];
try {
  const deadline = Date.now() + 45000;
  while (!log.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)) {
    assert.ok(
      child.exitCode === null && Date.now() < deadline,
      "local workerd did not become ready",
    );
    await new Promise((r) => setTimeout(r, 100));
  }
  const origin = log.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/)[1];
  async function compare(name, archive, authenticated = true) {
    const response = await fetch(`${origin}/?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body: archive,
      headers: authenticated ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    return {
      status: response.status,
      body: response.status === 404 ? null : await response.json(),
    };
  }
  for (const item of artifacts) {
    const result = await compare(item.name, item.archive);
    assert.equal(result.status, 200);
    assert.equal(result.body.stale, false);
    assert.equal(result.body.remoteHash, item.metadata.contentHash);
    results.push({ name: item.name, archiveBytes: item.archive.length, ...result.body });
  }
  const pack = tar.pack();
  const chunks = [];
  const drained = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  pack.entry({ name: "main.tf", type: "file" }, "modified fixture");
  pack.finalize();
  await drained;
  const changed = await compare(templateNames[0], Buffer.concat(chunks));
  assert.equal(changed.status, 200);
  assert.equal(changed.body.stale, true);
  const malformed = await compare(templateNames[0], Buffer.from("invalid tar"));
  assert.equal(malformed.status, 422);
  assert.equal((await compare("unknown", artifacts[0].archive)).status, 422);
  assert.equal((await compare(templateNames[0], artifacts[0].archive, false)).status, 404);
  assert.deepEqual(await digest(), before, "source changed during proof");
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    testedRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    scope:
      "Actual local workerd, canonical template hashing and five generated archives; no Coder HTTP or deployed browser acceptance",
    templateSource:
      templateRoot === process.cwd()
        ? "working checkout"
        : "isolated source export; all archives checked against the current manifest",
    passed: true,
    results,
    changedArchiveDetected: true,
    malformedArchiveRejected: true,
    unknownTemplateRejected: true,
    unauthenticatedRejected: true,
    cloudRequests: 0,
    sourceDigests: before,
  };
  await writeFile(
    "docs/checks/autonomous-delivery/template-comparison-workerd.json",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      passed: true,
      matchingTemplates: results.length,
      negativeChecks: 4,
      cloudRequests: 0,
    }),
  );
} catch (error) {
  await writeFile(join(directory, "private-runtime.log"), log, { mode: 0o600 });
  console.error(
    `Local template proof failed; runtime log retained at ${directory}/private-runtime.log`,
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  if (!process.exitCode) await rm(directory, { recursive: true, force: true });
}
