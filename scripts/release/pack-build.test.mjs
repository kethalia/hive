import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readReleaseArtifact } from "./artifact.mjs";

const exec = promisify(execFile),
  script = fileURLToPath(new URL("./pack-build.mjs", import.meta.url));
test("builder packages worker modules and assets while rejecting symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-release-pack-"));
  try {
    for (const path of ["build/app", "build/auth", ".open-next/assets"])
      await mkdir(join(dir, path), { recursive: true });
    await writeFile(join(dir, "build/app/worker.js"), "app");
    await writeFile(join(dir, "build/auth/worker.js"), "auth");
    await writeFile(join(dir, "build/auth/compiler.wasm"), "wasm");
    await writeFile(join(dir, ".open-next/assets/index.html"), "asset");
    await exec(process.execPath, [script], { cwd: dir });
    const files = await readReleaseArtifact(await readFile(join(dir, "release.tar")));
    assert.equal(files.get("auth/compiler.wasm").toString(), "wasm");
    assert.equal(files.get("assets/index.html").toString(), "asset");
    await rm(join(dir, "release.tar"));
    await symlink("/etc/passwd", join(dir, ".open-next/assets/link"));
    await assert.rejects(exec(process.execPath, [script], { cwd: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
