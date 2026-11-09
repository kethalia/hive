import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPilotMigration } from "./d10-pilot-migration.mjs";

test("pilot rejects unpinned source and any non-pilot database before connecting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hive-d10-guard-test-"));
  const ownerFile = join(directory, "url");
  const common = {
    repository: process.cwd(),
    ownerFile,
    appDigests: ["a".repeat(64), "b".repeat(64)],
    checkpointFile: join(directory, "checkpoint"),
    sourceSha: "c".repeat(40),
  };
  try {
    await assert.rejects(
      runPilotMigration({ ...common, sourceSha: "untrusted" }),
      /pilot_source_unpinned/,
    );
    for (const url of [
      "postgresql://fixture:fixture@localhost/hive_d10_pilot",
      "postgresql://fixture:fixture@valid.aws.neon.tech/hive_app_preview",
    ]) {
      await writeFile(ownerFile, url, { mode: 0o600 });
      await assert.rejects(runPilotMigration(common), /pilot_database_scope/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
