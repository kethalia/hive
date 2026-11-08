import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readReleaseArtifact } from "../../../../scripts/release/artifact.mjs";
import { packSourceBuild } from "../../src/delivery/pack-source-build.mjs";

test("packs single-Worker compatibility data with no retired uploader CLI in the candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-d10-pack-"));
  try {
    await mkdir(join(root, "build/app"), { recursive: true });
    await mkdir(join(root, ".open-next/assets"), { recursive: true });
    await writeFile(
      join(root, "build/app/worker.js"),
      "export default {fetch(){return new Response('local')}}",
    );
    await writeFile(join(root, ".open-next/assets/index.html"), "local-assets");
    await assert.rejects(readFile(join(root, "scripts/release/pack-build.mjs")));
    await packSourceBuild(root);
    const files = await readReleaseArtifact(await readFile(join(root, "release.tar")), {
      topology: "single",
    });
    assert.equal(files.get("assets/index.html").toString(), "local-assets");
    assert.ok(files.has("app/worker.js"));
    assert.equal(files.has("auth/worker.js"), false);
    await assert.rejects(packSourceBuild(root), /EEXIST/);
    await rm(join(root, "release.tar"));
    await symlink(join(root, "build/app/worker.js"), join(root, ".open-next/assets/link.js"));
    await assert.rejects(packSourceBuild(root), /source_build_symlink/);
    await assert.rejects(readFile(join(root, "release.tar")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
