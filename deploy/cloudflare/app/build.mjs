import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTemplateHashes } from "../../../scripts/build-template-hashes.mjs";
import { readProviderBuildIdentity } from "../../../scripts/release/provider-build-identity.mjs";
import {
  EMPTY_ENV_MODULE,
  READY_FILE,
  sourceDigests,
  writeBuildReady,
} from "./build-integrity.mjs";
import { writePortableActions } from "./portable-actions-build.mjs";

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const directory = ".artifacts/cloudflare";
await mkdir(directory, { recursive: true });
const lockPath = join(directory, "build.lock");
const lock = await open(lockPath, "wx");
await lock.writeFile(JSON.stringify({ pid: process.pid }));
const preserved = join(directory, `node-next-${randomUUID()}`);
let saved = false;
let staged = false;
try {
  readProviderBuildIdentity();
  await unlink(READY_FILE).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await buildTemplateHashes();
  const inputs = await sourceDigests();
  if (await exists(".next/lock")) throw new Error("A Next process currently owns .next");
  if (await exists(".next")) {
    await rename(".next", preserved);
    saved = true;
  }
  if (await exists(".next-cloudflare")) await rename(".next-cloudflare", ".next");
  staged = true;
  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "opennextjs-cloudflare",
        "build",
        "--config",
        "deploy/cloudflare/native/wrangler.jsonc",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          HIVE_RUNTIME_TARGET: "cloudflare",
          HIVE_DISABLE_BACKGROUND_WORKERS: "true",
        },
      },
    );
    if (result.status !== 0) throw new Error("Cloudflare application build failed");
  } finally {
    await mkdir(".open-next/cloudflare", { recursive: true });
    // OpenNext embeds local environment files. Only explicit runtime bindings may ship.
    await writeFile(".open-next/cloudflare/next-env.mjs", EMPTY_ENV_MODULE);
    if (staged && (await exists(".next"))) await rename(".next", ".next-cloudflare");
    if (saved) await rename(preserved, ".next");
  }
  await writePortableActions();
  await writeBuildReady(inputs);
} finally {
  await lock.close();
  await unlink(lockPath);
}
