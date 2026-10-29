import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertBuildReady,
  EMPTY_ENV_MODULE,
  sourceDigests,
  writeBuildReady,
} from "./build-integrity.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "hive-build-readiness-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const put = async (path, contents) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  };
  try {
    await put(".gitignore", "packages/db/src/generated/\n.open-next/\n");
    await put("src/app/page.tsx", "export default function Page() { return null; }");
    await put(
      "packages/db/src/generated/prisma-workerd/client.ts",
      "export const generated = true;",
    );
    await put(".open-next/worker.js", "export default {};");
    await put(
      ".open-next/server-functions/default/handler.mjs",
      "export const handler = () => {};",
    );
    await put(".open-next/cloudflare/next-env.mjs", EMPTY_ENV_MODULE);
    for (const dir of ["middleware", "assets", ".build/durable-objects"])
      await mkdir(join(root, ".open-next", dir), { recursive: true });
    await run({ root, put });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("interrupted or failed builds cannot be previewed without a readiness record", async () =>
  fixture(async ({ root }) => {
    await assert.rejects(assertBuildReady(root), /ENOENT/);
  }));

test("ready builds require empty generated environment and unchanged source/output", async () =>
  fixture(async ({ root, put }) => {
    const inputs = await sourceDigests(root);
    await writeBuildReady(inputs, root);
    assert.equal((await assertBuildReady(root)).schemaVersion, 1);
    await put(
      ".open-next/cloudflare/next-env.mjs",
      'export const production = {secret:"must-not-be-used"};',
    );
    await assert.rejects(assertBuildReady(root), /Generated environment is unsafe/);
    await put(".open-next/cloudflare/next-env.mjs", EMPTY_ENV_MODULE);
    await put("src/app/page.tsx", "export default function Changed() { return null; }");
    await assert.rejects(assertBuildReady(root), /sources changed/);
    await put("src/app/page.tsx", "export default function Page() { return null; }");
    await put(".open-next/worker.js", "export default { changed: true };");
    await assert.rejects(assertBuildReady(root), /output changed/);
  }));

test("a build with changed sources or unsafe environment cannot create readiness", async () =>
  fixture(async ({ root, put }) => {
    const inputs = await sourceDigests(root);
    await put("src/app/new-route.ts", "export const GET = () => null;");
    await assert.rejects(writeBuildReady(inputs, root), /Sources changed during/);
    await assert.rejects(assertBuildReady(root), /ENOENT/);
    await put(
      ".open-next/cloudflare/next-env.mjs",
      'export const production = {secret:"private"};',
    );
    await assert.rejects(
      writeBuildReady(await sourceDigests(root), root),
      /local environment must be removed/,
    );
  }));

test("new source files and ignored generated client changes invalidate readiness", async () =>
  fixture(async ({ root, put }) => {
    await writeBuildReady(await sourceDigests(root), root);
    await put(
      "packages/db/src/generated/prisma-workerd/client.ts",
      "export const generated = false;",
    );
    await assert.rejects(assertBuildReady(root), /sources changed/);
    await put(
      "packages/db/src/generated/prisma-workerd/client.ts",
      "export const generated = true;",
    );
    await put("src/app/new-route.ts", "export const GET = () => null;");
    await assert.rejects(assertBuildReady(root), /sources changed/);
  }));
