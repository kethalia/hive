import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePhaseB,
  phaseBFrame,
  phaseBHasBudget,
  phaseBMarkerItems,
  phaseBPermit,
  phaseBSocket,
} from "./phase-b-policy.mjs";
import { ORIGIN, TARGET } from "./policy.mjs";

const id = "20000000-0000-4000-8000-000000000001";
const scope = parsePhaseB({
  schemaVersion: 1,
  sourceRevision: "a".repeat(40),
  ...TARGET,
  preflightDigest: "b".repeat(64),
  expectedAppVersion: "test",
  expectedAppBuild: "build",
  priorForwarded: 148,
  incrementalBudget: 200,
  attemptId: id,
  projectId: id,
  taskId: id,
  ownerId: id,
  buildId: id,
  serverInstanceId: id,
  threadId: "thread-1",
  marker: "HIVE_PILOT_ABCDEFGH",
  start: null,
});
test("existing session is limited to scoped project and read-only socket operations", () => {
  assert(phaseBPermit(scope, `${ORIGIN}/api/projects/${id}/session-grant`, "POST"));
  assert(
    phaseBPermit(
      scope,
      `${ORIGIN}/api/projects/${id}/tasks/status`,
      "POST",
      {},
      JSON.stringify({ workspaceId: scope.workspaceId, taskId: id, requestId: id }),
    ),
  );
  assert(!phaseBPermit(scope, `${ORIGIN}/api/projects/${id}/tasks/start`, "POST", {}, "{}"));
  assert(!phaseBPermit(scope, `${ORIGIN}/api/projects/${id}/tasks/retry`, "POST", {}, "{}"));
  assert(!phaseBPermit(scope, `${ORIGIN}/api/projects/${id}/session-grant?x=1`, "POST"));
  assert(phaseBSocket(scope, `${ORIGIN.replace("https:", "wss:")}/api/projects/${id}/session`));
  assert(!phaseBSocket(scope, `wss://example.invalid/api/projects/${id}/session`));
  assert(phaseBFrame("session", JSON.stringify({ id: 1, method: "thread/resume", params: {} })));
  assert(!phaseBFrame("session", JSON.stringify({ id: 1, method: "turn/start", params: {} })));
  assert(phaseBFrame("terminal", JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
  assert(!phaseBFrame("terminal", JSON.stringify({ type: "input", text: "rm -rf /" })));
});
test("one optional start pins the exact operator intent and base", () => {
  const fresh = parsePhaseB({
    ...scope,
    taskId: null,
    serverInstanceId: null,
    threadId: null,
    start: { expectedRevision: "c".repeat(40), text: "Approved task" },
  });
  const body = { workspaceId: fresh.workspaceId, requestId: id, ...fresh.start };
  assert(
    phaseBPermit(
      fresh,
      `${ORIGIN}/api/projects/${id}/tasks/start`,
      "POST",
      {},
      JSON.stringify(body),
    ),
  );
  assert(
    !phaseBPermit(
      fresh,
      `${ORIGIN}/api/projects/${id}/tasks/start`,
      "POST",
      {},
      JSON.stringify({ ...body, text: "Different task" }),
    ),
  );
  assert.throws(() =>
    parsePhaseB({ ...scope, start: { expectedRevision: "c".repeat(40), text: "Approved task" } }),
  );
});

test("history extracts only matching agent turn and item IDs, without returning text", () => {
  const marker = "HIVE_PILOT_ABCDEFGH";
  const frame = JSON.stringify({
    result: {
      data: [
        {
          id: "turn-1",
          items: [
            { id: "item-1", type: "agentMessage", text: `response ${marker}` },
            { id: "user-1", type: "userMessage", text: marker },
          ],
        },
      ],
    },
  });
  assert.deepEqual(phaseBMarkerItems(frame, marker), [["turn-1", "item-1"]]);
  assert.deepEqual(
    phaseBMarkerItems(JSON.stringify({ result: { data: [{ id: "turn", items: [] }] } }), marker),
    [],
  );
});

test("phase B records prior usage separately and bounds the additional allowance", () => {
  assert.equal(scope.priorForwarded, 148);
  assert.equal(scope.incrementalBudget, 200);
  assert(phaseBHasBudget(scope, 346));
  assert(!phaseBHasBudget(scope, 347));
  assert(phaseBHasBudget(scope, 347, true));
  assert(!phaseBHasBudget(scope, 348, true));
  assert(!phaseBHasBudget(scope, 147));
  assert.equal(parsePhaseB({ ...scope, priorForwarded: 348 }).priorForwarded, 348);
  assert.throws(() => parsePhaseB({ ...scope, priorForwarded: -1 }));
  assert.throws(() => parsePhaseB({ ...scope, incrementalBudget: 201 }));
  assert.throws(() => parsePhaseB({ ...scope, incrementalBudget: 1 }));
});
