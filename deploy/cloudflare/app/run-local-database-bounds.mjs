import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateRuntimeDatabase } from "./deployment-plan.mjs";

const paths = [
  "deploy/cloudflare/app/local-database-bounds.ts",
  "deploy/cloudflare/app/run-local-database-bounds.mjs",
  "deploy/cloudflare/app/deployment-plan.mjs",
  "packages/db/src/cloudflare.ts",
  "packages/db/src/request-scope.ts",
  "packages/db/src/generated/prisma-workerd/client.ts",
  "packages/db/src/generated/prisma-workerd/internal/class.ts",
  "packages/db/prisma/schema.prisma",
  "packages/db/package.json",
  "pnpm-lock.yaml",
];
const digest = async () =>
  Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
const sources = await digest(),
  revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const runtimeUrl = (
  await readFile("/tmp/hive-epic-coder-auth/neon-app-preview-runtime-url", "utf8")
).trim();
validateRuntimeDatabase(runtimeUrl);
const directory = await mkdtemp(join(tmpdir(), "hive-database-bounds-")),
  bearer = randomBytes(32).toString("hex");
await writeFile(
  join(directory, "wrangler.json"),
  JSON.stringify({
    name: "hive-local-database-bounds",
    main: resolve(paths[0]),
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
  }),
  { mode: 0o600 },
);
await writeFile(
  join(directory, ".dev.vars"),
  `DATABASE_URL=${JSON.stringify(runtimeUrl)}\nPROOF_BEARER=${bearer}\n`,
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
    join(directory, "wrangler.json"),
    "--ip",
    "127.0.0.1",
    "--port",
    "8795",
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
child.stdout.on("data", (bytes) => {
  log += bytes;
});
child.stderr.on("data", (bytes) => {
  log += bytes;
});
try {
  const deadline = Date.now() + 60000;
  while (!log.includes("Ready on")) {
    if (child.exitCode !== null || Date.now() >= deadline)
      throw new Error("Local runtime unavailable");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const response = await fetch("http://127.0.0.1:8795/__local-query-bound", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Local timeout fixture rejected");
  const result = await response.json();
  const sourceStable = JSON.stringify(sources) === JSON.stringify(await digest());
  const ok =
    result.rejected &&
    result.kind === "query_read_timeout" &&
    result.closeCompleted &&
    result.closedAtMilliseconds < 15000 &&
    sourceStable;
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    testedRevision: revision,
    testedSourceCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...paths], {
      encoding: "utf8",
    }).trim(),
    sourceStable,
    sourceDigests: sources,
    scope: "actual local workerd + restricted isolated Neon runtime role, fixed read-only SQL",
    ok,
    result,
    cloudWorkerRequests: 0,
    databaseDml: false,
    limitation:
      "Driver query timeout is not proof of instantaneous PostgreSQL cancellation; actual disconnect/drain timing is recorded separately.",
  };
  const path = "docs/checks/autonomous-delivery/cloudflare-database-bounds.json";
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", path], { stdio: "ignore" });
  console.log(
    JSON.stringify({ ok, result, sourceStable, cloudWorkerRequests: 0, databaseDml: false }),
  );
  if (!ok) process.exitCode = 1;
} catch {
  console.error(
    "Local read-only database bound proof failed; inspect private runtime log. No secrets printed.",
  );
  process.exitCode = 1;
} finally {
  await writeFile("/tmp/hive-database-bounds-private.log", log, { mode: 0o600 });
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
