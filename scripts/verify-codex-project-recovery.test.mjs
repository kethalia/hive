import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  projectRecovery,
  recoveryDigest,
  recoveryHeld,
  validateRecoveryRequest,
} from "../templates/ai-dev-k8s/scripts/codex-project-recovery.mjs";

function fixture(existing = false) {
  const config = { ownerId: randomUUID(), workspaceId: randomUUID() },
    buildId = randomUUID();
  let p = { projectId: randomUUID(), repositoryId: "123", expectedAccountId: "456", task: null },
    saved,
    scheduled = 0,
    fences = 0,
    unknown = false;
  const s = {
    recoveryId: randomUUID(),
    ownerId: randomUUID(),
    coderOwnerId: config.ownerId,
    projectId: p.projectId,
    taskId: randomUUID(),
    workspaceId: config.workspaceId,
    originalRequestId: randomUUID(),
    intentVersion: "v1",
    intentDigest: "a".repeat(64),
    hostRequestDigest: "b".repeat(64),
    repositoryId: "123",
    providerAccountId: "456",
    revision: "c".repeat(40),
  };
  if (existing)
    p.task = {
      taskId: s.taskId,
      request: { requestId: s.originalRequestId, revision: s.revision },
      digest: s.hostRequestDigest,
      phase: "blocked",
      reason: "native_unavailable",
    };
  const guardian = {
    state: { phase: "open", lifetimeId: randomUUID(), generation: 1 },
    async identity(nonce) {
      assert(recoveryHeld(p));
      if (unknown) throw Error("unknown");
      return {
        nonce,
        identity: { lifetimeId: guardian.state.lifetimeId },
        startup: { generation: guardian.state.generation },
      };
    },
  };
  let failFence = false;
  const build = () =>
    projectRecovery({
      config,
      guardian,
      buildId,
      save() {
        saved = structuredClone(p);
      },
      taskDigest: () => s.hostRequestDigest,
      async prove() {
        assert.equal(p.task.phase, "blocked");
      },
      async absent() {
        assert(!p.task);
      },
      async fence() {
        fences++;
        assert.equal(saved.recovery.phase, "consuming");
        assert.equal(saved.task.phase, "preparing");
        assert(recoveryHeld(p));
        if (failFence) throw Error("revoked");
      },
      schedule() {
        assert.equal(saved.recovery.phase, "consumed");
        scheduled++;
      },
    });
  let recovery = build();
  return {
    s,
    guardian,
    get p() {
      return p;
    },
    get saved() {
      return saved;
    },
    get scheduled() {
      return scheduled;
    },
    get fences() {
      return fences;
    },
    fail() {
      failFence = true;
    },
    unknown() {
      unknown = true;
    },
    restart() {
      p = structuredClone(saved);
      recovery = build();
    },
    inspect: () => recovery("/projects/tasks/recovery-inspect", p, { schemaVersion: 1, scope: s }),
    consume: (a) =>
      recovery("/projects/tasks/recovery-consume", p, {
        schemaVersion: 1,
        scope: s,
        authorization: a,
      }),
    authorization: (i) => ({
      inspectionDigest: recoveryDigest(i.inspection),
      authorizedVersion: "v2",
      buildId,
      lifetimeId: guardian.state.lifetimeId,
      expiresAt: Date.now() + 30000,
    }),
  };
}
test("absent task inspection gates inputs; receipt replay after restart never schedules a prompt", async () => {
  const f = fixture(),
    i = await f.inspect(),
    a = f.authorization(i);
  assert(recoveryHeld(f.p));
  assert.equal(i.identity.nonce, recoveryDigest({ scope: f.s, inspection: i.inspection }));
  assert.equal(JSON.stringify(i).includes("text"), false);
  f.restart();
  const receipt = await f.consume(a);
  assert.equal(receipt.outcome, "task_absent");
  assert(!recoveryHeld(f.p));
  f.restart();
  assert.deepEqual(await f.consume(a), receipt);
  assert.equal(f.scheduled, 0);
  assert.equal(f.fences, 0);
});
test("existing task has durable CAS authorization before fresh fence, durable receipt before once scheduling", async () => {
  const f = fixture(true),
    i = await f.inspect(),
    a = f.authorization(i);
  const receipt = await f.consume(a);
  assert.equal(f.fences, 1);
  assert.equal(f.scheduled, 1);
  f.restart();
  assert.deepEqual(await f.consume({ ...a, expiresAt: a.expiresAt }), receipt);
  assert.equal(f.scheduled, 1);
  await assert.rejects(f.consume({ ...a, authorizedVersion: "v3" }), /retry_not_available/);
});
test("expired, mismatched, or changed facts cannot consume or invoke fresh authority", async () => {
  const f = fixture(true),
    i = await f.inspect(),
    a = f.authorization(i);
  for (const bad of [
    { ...a, expiresAt: Date.now() - 1 },
    { ...a, lifetimeId: randomUUID() },
    { ...a, inspectionDigest: "f".repeat(64) },
  ])
    await assert.rejects(f.consume(bad), /retry_not_available/);
  f.p.task.reason = "different";
  await assert.rejects(f.consume(a), /retry_not_available/);
  assert.equal(f.fences, 0);
  assert.equal(f.scheduled, 0);
  assert(recoveryHeld(f.p));
});
test("failed fresh fence and uncertain identity survive restart held without schedule", async () => {
  const f = fixture(true),
    i = await f.inspect();
  f.fail();
  await assert.rejects(f.consume(f.authorization(i)), /revoked/);
  f.restart();
  assert.equal(f.p.recovery.phase, "held");
  await assert.rejects(f.inspect(), /retry_not_available/);
  assert.equal(f.scheduled, 0);
  const absent = fixture();
  absent.unknown();
  await assert.rejects(absent.inspect(), /unknown/);
  assert(recoveryHeld(absent.saved));
});
test("strict recovery envelope rejects prompts and other task/lifetime scopes", async () => {
  const f = fixture();
  assert.throws(
    () =>
      validateRecoveryRequest("/projects/tasks/recovery-inspect", {
        schemaVersion: 1,
        scope: f.s,
        text: "prompt",
      }),
    /retry_not_available/,
  );
  await f.inspect();
  f.s.taskId = randomUUID();
  await assert.rejects(f.inspect(), /retry_not_available/);
});
