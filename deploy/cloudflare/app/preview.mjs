import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertBuildReady } from "./build-integrity.mjs";

await assertBuildReady();
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--port" && /^\d{4,5}$/.test(args[1])),
);
const port = Number(args[1] ?? 8787);
assert.ok(port >= 1024 && port <= 65535);
const config = JSON.parse(await readFile("deploy/cloudflare/native/wrangler.jsonc", "utf8"));
config.vars = { ...config.previews.vars, HIVE_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` };
config.main = resolve("deploy/cloudflare/native/worker.ts");
config.assets.directory = resolve(".open-next/assets");
delete config.previews;
await mkdir(".artifacts/cloudflare", { recursive: true });
const path = ".artifacts/cloudflare/local-config.json";
await writeFile(path, JSON.stringify(config));
const result = spawnSync(
  "pnpm",
  ["exec", "wrangler", "dev", "--config", path, "--ip", "127.0.0.1", "--port", String(port)],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
