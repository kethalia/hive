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

test("the shared terminal protocol is pinned and a later edit invalidates build readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-foundation-build-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    for (const path of [
      "services/terminal-proxy/src",
      "packages/db/src/generated/prisma-workerd",
      ".open-next/cloudflare",
      ".open-next/middleware",
      ".open-next/assets",
      ".open-next/.build/durable-objects",
      ".open-next/server-functions/default",
    ])
      await mkdir(join(root, path), { recursive: true });
    const protocol = join(root, "services/terminal-proxy/src/protocol.ts");
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
    assert.ok(inputs["services/terminal-proxy/src/protocol.ts"]);
    await writeBuildReady(inputs, root);
    await assertBuildReady(root);
    await writeFile(protocol, "export const version = 2;\n");
    await assert.rejects(assertBuildReady(root), /sources changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
