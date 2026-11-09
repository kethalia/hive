import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setupF08Role } from "./f08-restored-role.mjs";

test("F08 role setup rejects wrong targets and malformed fixture IDs before writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-f08-guard-")),
    ownerFile = join(dir, "url"),
    runtimeFile = join(dir, "runtime"),
    checkpointFile = join(dir, "checkpoint");
  try {
    await writeFile(
      ownerFile,
      "postgresql://fixture:fixture@other.aws.neon.tech/hive_production_rehearsal_20261105",
      { mode: 0o600 },
    );
    await assert.rejects(
      setupF08Role({
        ownerFile,
        runtimeFile,
        checkpointFile,
        fixtureId: "11111111-1111-4111-8111-111111111111",
      }),
      /f08_database_scope/,
    );
    await assert.rejects(
      setupF08Role({ ownerFile, runtimeFile, checkpointFile, fixtureId: "wrong" }),
      /f08_fixture_id_invalid/,
    );
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), ["url"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
