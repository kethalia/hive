import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const EMPTY_ENV_MODULE =
  "export const production = {};\nexport const development = {};\nexport const test = {};\n";
export const READY_FILE = ".open-next/hive-build-ready.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourcePaths = [
  "src",
  "packages",
  "public",
  "services/auth/src",
  "deploy/cloudflare/app",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "next.config.ts",
  "open-next.config.ts",
  "tsconfig.json",
  ".gitignore",
];

async function filesBelow(root, directory) {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesBelow(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function digestFiles(root, paths) {
  const result = {};
  for (const path of [...new Set(paths)].sort())
    result[path] = sha256(await readFile(join(root, path)));
  return result;
}

export async function sourceDigests(root = process.cwd()) {
  const listed = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z", "--", ...sourcePaths],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const sources = listed.filter(
    (path) =>
      path.startsWith("public/") ||
      ((/\.(ts|tsx|js|mjs|cjs|json|jsonc|css|prisma|yaml)$/.test(path) ||
        path.endsWith(".gitignore")) &&
        path !== "deploy/cloudflare/app/local-evidence.json"),
  );
  // This ignored generated client is an actual input of the custom Worker.
  sources.push(...(await filesBelow(root, "packages/db/src/generated/prisma-workerd")));
  return digestFiles(root, sources);
}

async function outputDigests(root) {
  const outputs = [".open-next/worker.js", ".open-next/server-functions/default/handler.mjs"];
  for (const directory of [
    ".open-next/cloudflare",
    ".open-next/middleware",
    ".open-next/assets",
    ".open-next/.build/durable-objects",
  ])
    outputs.push(...(await filesBelow(root, directory)));
  return digestFiles(root, outputs);
}

export async function writeBuildReady(inputs, root = process.cwd()) {
  assert.equal(
    await readFile(join(root, ".open-next/cloudflare/next-env.mjs"), "utf8"),
    EMPTY_ENV_MODULE,
    "Generated local environment must be removed before marking a build ready",
  );
  assert.deepEqual(
    await sourceDigests(root),
    inputs,
    "Sources changed during the Cloudflare build; rebuild before preview",
  );
  const record = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    inputs,
    outputs: await outputDigests(root),
  };
  await writeFile(join(root, READY_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

export async function assertBuildReady(root = process.cwd()) {
  const record = JSON.parse(await readFile(join(root, READY_FILE), "utf8"));
  assert.equal(record.schemaVersion, 1, "Unknown Cloudflare build readiness version");
  assert.equal(
    await readFile(join(root, ".open-next/cloudflare/next-env.mjs"), "utf8"),
    EMPTY_ENV_MODULE,
    "Generated environment is unsafe; rebuild before preview",
  );
  assert.deepEqual(
    await sourceDigests(root),
    record.inputs,
    "Cloudflare build sources changed; rebuild before preview",
  );
  assert.deepEqual(
    await outputDigests(root),
    record.outputs,
    "Cloudflare build output changed; rebuild before preview",
  );
  return record;
}
