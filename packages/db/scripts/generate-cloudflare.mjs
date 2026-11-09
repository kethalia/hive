import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonical = await readFile(join(directory, "prisma/schema.prisma"), "utf8");
const pattern = /generator\s+client\s*\{[^}]*\}/g;
assert.equal(
  [...canonical.matchAll(pattern)].length,
  1,
  "Expected one canonical Prisma client generator",
);
const generator = `generator client {
  provider = "prisma-client"
  output = ${JSON.stringify(join(directory, "src/generated/prisma-workerd"))}
  runtime = "workerd"
  moduleFormat = "esm"
  engineType = "client"
}`;
const temporary = await mkdtemp(join(tmpdir(), "hive-prisma-workerd-"));
try {
  const schema = join(temporary, "schema.prisma");
  await writeFile(schema, canonical.replace(pattern, generator));
  const result = spawnSync("pnpm", ["exec", "prisma", "generate", "--schema", schema], {
    cwd: directory,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
