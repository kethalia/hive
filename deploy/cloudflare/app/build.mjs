import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EMPTY_ENV_MODULE,
  READY_FILE,
  sourceDigests,
  writeBuildReady,
} from "./build-integrity.mjs";

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const artifacts = ".artifacts/cloudflare";
await mkdir(artifacts, { recursive: true });
const lockPath = join(artifacts, "build.lock");
const lock = await open(lockPath, "wx");
await lock.writeFile(JSON.stringify({ pid: process.pid, task: "cloudflare-app-build" }));
const preserved = join(artifacts, `node-next-${randomUUID()}`);
let savedNodeBuild = false;
let staged = false;
let inputs;
try {
  await unlink(READY_FILE).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  inputs = await sourceDigests();
  if (await exists(".next/lock"))
    throw new Error("Another Next build/dev process owns .next; stop it before this build.");
  if (await exists(".next")) {
    await rename(".next", preserved);
    savedNodeBuild = true;
  }
  // OpenNext currently hardcodes .next. Preserve the Node build and reuse the
  // previous Cloudflare cache without changing the application's distDir.
  if (await exists(".next-cloudflare")) await rename(".next-cloudflare", ".next");
  staged = true;
  const result = spawnSync(
    "pnpm",
    ["exec", "opennextjs-cloudflare", "build", "--config", "deploy/cloudflare/app/wrangler.jsonc"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        HIVE_RUNTIME_TARGET: "cloudflare",
        HIVE_DISABLE_BACKGROUND_WORKERS: "true",
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  // The vendor emits all local .env* contents here, including non-public values.
  // Keep generated artifacts usable only with explicit runtime bindings instead.
  await mkdir(".open-next/cloudflare", { recursive: true });
  await writeFile(".open-next/cloudflare/next-env.mjs", EMPTY_ENV_MODULE);
  if (staged && (await exists(".next"))) await rename(".next", ".next-cloudflare");
  if (savedNodeBuild) await rename(preserved, ".next");
  await lock.close();
  await unlink(lockPath);
}
if (process.exitCode === 0) await writeBuildReady(inputs);
