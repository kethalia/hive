import assert from "node:assert/strict";
import test from "node:test";
import { createAcceptancePump } from "../templates/ai-dev-k8s/scripts/codex-acceptance-pump.mjs";

function fixture(options = {}) {
  const state = {},
    calls = [],
    native = { creates: 0, runs: 0, archives: 0 };
  let active = false,
    failed = false;
  const job = { phase: "leased", jobId: "job", leaseId: "lease", leaseGeneration: 1 };
  const client = {
    async request(action) {
      calls.push(action);
      if (action === "claim_acceptance") return job;
      if (action === "start_acceptance")
        return { phase: "started", jobId: "job", threadId: "thread" };
      if (options.loseAck && !failed) {
        failed = true;
        throw Error("lost_ack");
      }
      return { phase: "completed", jobId: "job", resultDigest: "digest" };
    },
  };
  const evaluator = {
    async create() {
      native.creates++;
      active = true;
      return { threadId: "thread" };
    },
    async run() {
      native.runs++;
      if (options.delay) await options.delay;
      return { output: "{}", receipt: {} };
    },
    async archive() {
      native.archives++;
      active = false;
    },
    active: () => active,
    closeAdmission() {},
    reopenAdmission() {},
    close() {},
  };
  const make = () =>
    createAcceptancePump({
      client,
      evaluator,
      state,
      save() {},
      assertAuthority() {
        if (options.revoked) throw Error("revoked");
      },
    });
  return { state, calls, native, make };
}
test("automatic pump persists native boundary and completes one inference", async () => {
  const f = fixture();
  await f.make().tick();
  assert.deepEqual(f.native, { creates: 1, runs: 1, archives: 1 });
  assert.equal(f.state.operation, null);
});
test("lost result ACK restart repeats exact result, never native inference", async () => {
  const f = fixture({ loseAck: true });
  await assert.rejects(f.make().tick(), /lost_ack/);
  assert.equal(f.state.operation.phase, "finish_requested");
  await f.make().tick();
  assert.equal(f.native.runs, 1);
  assert.equal(f.native.creates, 1);
  assert.deepEqual(f.calls, [
    "claim_acceptance",
    "start_acceptance",
    "finish_acceptance",
    "finish_acceptance",
  ]);
});
test("unknown native submission cannot be retried after restart", async () => {
  const f = fixture();
  f.state.operation = {
    phase: "submission_attempted",
    job: { jobId: "job", leaseId: "lease", leaseGeneration: 1 },
  };
  await assert.rejects(f.make().tick(), /reconciliation/);
  assert.equal(f.native.runs, 0);
  assert.equal(f.calls.length, 0);
});
test("barrier closes new claims and waits exact existing evaluator archive", async () => {
  let release;
  const delay = new Promise((r) => (release = r));
  const f = fixture({ delay }),
    pump = f.make();
  const running = pump.tick();
  while (!f.native.runs) await new Promise((r) => setImmediate(r));
  const closing = pump.closeAdmission();
  release();
  await running;
  assert.deepEqual(await closing, {
    closed: true,
    evaluatorThreads: 0,
    quiescenceAuthorized: false,
  });
  assert.deepEqual(await pump.tick(), { phase: "closed" });
  assert.equal(f.native.runs, 1);
});
test("late result after revocation cannot be submitted or release input", async () => {
  let release;
  const options = { delay: new Promise((r) => (release = r)), revoked: false },
    f = fixture(options),
    pump = f.make();
  const pending = pump.tick();
  while (!f.native.runs) await new Promise((r) => setImmediate(r));
  options.revoked = true;
  release();
  await assert.rejects(pending, /revoked/);
  assert.equal(f.state.operation.phase, "submission_attempted");
  assert.ok(!f.calls.includes("finish_acceptance"));
  await assert.rejects(pump.closeAdmission());
});
