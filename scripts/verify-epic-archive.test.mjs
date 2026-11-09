import { strict as assert } from "node:assert";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { archiveClosedProjectState } from "../templates/ai-dev-k8s/scripts/codex-project-controller.mjs";

const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("archives the signed journal before resetting only after scoped closure tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-epic-archive-"));
  try {
    const key = Buffer.alloc(32, 1),
      { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const config = { stateDirectory: dir, ownerId: u(1), workspaceId: u(2) };
    const claim = {
      schemaVersion: 1,
      ownerId: u(1),
      hiveUserId: u(11),
      workspaceId: u(2),
      buildId: u(3),
      projectId: u(4),
      repositoryId: "123",
      taskId: u(5),
      requestId: u(6),
      leaseId: u(7),
      leaseGeneration: 2,
      checkoutIncarnation: u(8),
      acceptedSourceSha: "a".repeat(40),
      priorLifetimeId: u(9),
      barrierId: u(10),
      treeReceiptDigest: "b".repeat(64),
      preservationDigest: "c".repeat(64),
      leaseReleaseDigest: "d".repeat(64),
      expiresAt: Date.now() + 30000,
    };
    const state = {
      schemaVersion: 1,
      ownerId: u(1),
      workspaceId: u(2),
      guardianLifetimeId: u(9),
      guardianBarrier: { barrierId: u(10) },
      projects: {
        [u(4)]: {
          projectId: u(4),
          repositoryId: "123",
          task: {
            taskId: u(5),
            request: { requestId: u(6), revision: claim.acceptedSourceSha },
            prepared: { leaseId: u(7), leaseGeneration: 2 },
            guardianPreparation: { buildId: u(3) },
            checkoutIncarnation: u(8),
          },
        },
      },
    };
    writeFileSync(join(dir, "projects.key"), key, { mode: 0o600 });
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify({
        state,
        signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
      }),
      { mode: 0o600 },
    );
    const token = (c) => {
      const body = Buffer.from(JSON.stringify(c)).toString("base64url");
      return `${body}.${sign(null, Buffer.from(`hive-project-archive-v1\n${body}`), privateKey).toString("base64url")}`;
    };
    const pem = publicKey.export({ type: "spki", format: "pem" });
    assert.throws(
      () => archiveClosedProjectState(config, [token({ ...claim, leaseGeneration: 3 })], pem),
      /archive_scope_invalid/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, "projects.json"))).state.projects[u(4)].task.taskId,
      u(5),
    );
    const result = archiveClosedProjectState(config, [token(claim)], pem);
    assert.equal(result.taskCount, 1);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "projects.json"))).state.projects[u(4)].task,
      null,
    );
    const file = readdirSync(dir).find((name) => name.startsWith("projects-archive-"));
    assert.equal(JSON.parse(readFileSync(join(dir, file))).state.projects[u(4)].task.taskId, u(5));
    const replay = archiveClosedProjectState(
      config,
      [token({ ...claim, expiresAt: Date.now() + 40000 })],
      pem,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.archiveDigest, result.archiveDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
