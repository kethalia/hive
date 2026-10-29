import { spawnSync } from "node:child_process";
import { assertBuildReady } from "./build-integrity.mjs";

try {
  await assertBuildReady();
} catch {
  console.error(
    "Cloudflare application build is absent, interrupted or stale. Run pnpm build:cloudflare before preview.",
  );
  process.exit(1);
}
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "opennextjs-cloudflare",
    "preview",
    "--config",
    "deploy/cloudflare/app/wrangler.jsonc",
    "--ip",
    "127.0.0.1",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
