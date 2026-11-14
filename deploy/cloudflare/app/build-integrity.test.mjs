import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertBuildReady,
  EMPTY_ENV_MODULE,
  sourceDigests,
  writeBuildReady,
} from "./build-integrity.mjs";

for (const source of [
  "services/terminal-proxy/src/protocol.ts",
  "scripts/artifact-paths.mjs",
  "public/hive-runtime-artifacts/scripts/notifications/install.py",
])
  test(`build readiness pins ${source} including ignored generated inputs`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-foundation-build-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      for (const path of [
        "services/terminal-proxy/src",
        "scripts",
        "public/hive-runtime-artifacts/scripts/notifications",
        "packages/db/src/generated/prisma-workerd",
        ".open-next/cloudflare",
        ".open-next/middleware",
        ".open-next/assets",
        ".open-next/.build/durable-objects",
        ".open-next/server-functions/default",
      ])
        await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, ".gitignore"), "public/hive-runtime-artifacts/\n");
      const protocol = join(root, source);
      await writeFile(protocol, "export const version = 1;\n");
      await writeFile(
        join(root, "packages/db/src/generated/prisma-workerd/client.ts"),
        "export {};\n",
      );
      await writeFile(join(root, ".open-next/cloudflare/next-env.mjs"), EMPTY_ENV_MODULE);
      await writeFile(join(root, ".open-next/worker.js"), "export default {};\n");
      await writeFile(
        join(root, ".open-next/server-functions/default/handler.mjs"),
        "export default {};\n",
      );
      const inputs = await sourceDigests(root);
      assert.ok(inputs[source]);
      await writeBuildReady(inputs, root);
      await assertBuildReady(root);
      await writeFile(protocol, "export const version = 2;\n");
      await assert.rejects(assertBuildReady(root), /sources changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
