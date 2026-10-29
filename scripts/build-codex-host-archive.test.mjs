import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostArchive } from "./build-codex-host-archive.mjs";

test("host archive has the same digest across checkouts sharing a dependency store", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "hive-archive-repro-"));
  try {
    const expected = await hostArchive(process.cwd());
    await mkdir(join(temporary, "scripts"));
    await cp(
      "scripts/build-codex-host-bundle.mjs",
      join(temporary, "scripts/build-codex-host-bundle.mjs"),
    );
    await mkdir(join(temporary, "templates/ai-dev-k8s"), { recursive: true });
    await cp("templates/ai-dev-k8s/scripts", join(temporary, "templates/ai-dev-k8s/scripts"), {
      recursive: true,
    });
    await symlink(join(process.cwd(), "node_modules"), join(temporary, "node_modules"), "dir");
    const actual = await hostArchive(temporary);
    assert.equal(actual.sha256, expected.sha256);
    assert.deepEqual(actual.archive, expected.archive);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
