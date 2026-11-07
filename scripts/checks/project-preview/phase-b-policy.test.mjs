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
import { NATIVE_ORIGIN, NATIVE_WORKSPACE, ORIGIN, parseScope, TARGET } from "./policy.mjs";

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
test("existing session accepts only the two reviewed workspaces and keeps the repository binding", () => {
  const flow = "49dfbaf2-f475-4053-8c6b-2fc09d0db8bf";
  assert.equal(parsePhaseB(scope).workspaceId, TARGET.workspaceId);
  assert.equal(parsePhaseB({ ...scope, workspaceId: flow }).workspaceId, flow);
  assert.throws(() => parsePhaseB({ ...scope, workspaceId: id }));
  assert.throws(() => parsePhaseB({ ...scope, workspaceId: flow, repositoryId: "999" }));
  assert.throws(() => parsePhaseB({ ...scope, workspaceId: flow, providerAccountId: "999" }));
  assert.throws(() => parsePhaseB({ ...scope, workspaceId: flow, threadId: null }));
});
test("managed 20Gi pilot binds its exact workspace and marker without server logout", () => {
  const managed = parsePhaseB({
    ...scope,
    workspaceId: "35dded27-d8bd-479c-a44a-f20b766349af",
    marker: "HIVE_MANAGED_PILOT_20261107_20G",
    incrementalBudget: 52,
  });
  assert(phaseBPermit(managed, `${NATIVE_ORIGIN}/api/app-version`, "GET"));
  assert(!phaseBPermit(managed, `${NATIVE_ORIGIN}/api/auth/logout`, "POST"));
  assert(!phaseBPermit(managed, `${ORIGIN}/api/app-version`, "GET"));
  assert.throws(() => parsePhaseB({ ...managed, workspaceId: NATIVE_WORKSPACE }));
  assert.throws(() => parsePhaseB({ ...managed, marker: "HIVE_MANAGED_PILOT_DIFFERENT" }));
});
test("optional Delivery report proof permits only pinned reads, with no notice or task mutations", () => {
  const delivery = { taskId: id, reportId: id, eventId: id },
    pinned = parsePhaseB({ ...scope, delivery });
  for (const route of [
    "/api/delivery/tasks",
    `/api/delivery/tasks/${id}`,
    `/api/delivery/tasks/${id}?report=${id}`,
    `/workspaces?panel=delivery&task=${id}&report=${id}`,
  ])
    assert(phaseBPermit(pinned, `${ORIGIN}${route}`, "GET"));
  for (const [route, method] of [
    [`/api/delivery/tasks/${id}`, "POST"],
    [`/api/delivery/tasks/${id}/pause`, "POST"],
    [`/api/delivery/tasks/${id}?report=${id}&report=${id}`, "GET"],
    ["/api/delivery/tasks?cursor=other", "GET"],
    ["/api/delivery/tasks/30000000-0000-4000-8000-000000000001", "GET"],
    [`/workspaces?panel=delivery&task=${id}&report=30000000-0000-4000-8000-000000000001`, "GET"],
  ])
    assert(!phaseBPermit(pinned, `${ORIGIN}${route}`, method));
  assert(!phaseBPermit(scope, `${ORIGIN}/api/delivery/tasks`, "GET"));
  assert.throws(() => parsePhaseB({ ...scope, delivery: { ...delivery, eventId: "unknown" } }));
  assert.throws(() => parsePhaseB({ ...scope, delivery: { ...delivery, origin: ORIGIN } }));
});
test("native Phase B binds the reviewed workspace to its exact origin", () => {
  const native = parsePhaseB({ ...scope, workspaceId: NATIVE_WORKSPACE, incrementalBudget: 52 });
  const path = `/api/projects/${id}/tasks/status`;
  const body = JSON.stringify({ workspaceId: NATIVE_WORKSPACE, taskId: id, requestId: id });
  assert(phaseBPermit(native, `${NATIVE_ORIGIN}${path}`, "POST", {}, body));
  assert(!phaseBPermit(native, `${ORIGIN}${path}`, "POST", {}, body));
  assert(!phaseBPermit(scope, `${NATIVE_ORIGIN}${path}`, "POST", {}, body));
  assert(phaseBPermit(native, `${NATIVE_ORIGIN}/login`, "GET"));
  assert(!phaseBPermit(native, `${ORIGIN}/login`, "GET"));
  assert(
    phaseBSocket(native, `${NATIVE_ORIGIN.replace("https:", "wss:")}/api/projects/${id}/session`),
  );
  assert(!phaseBSocket(native, `${ORIGIN.replace("https:", "wss:")}/api/projects/${id}/session`));
  assert(
    !phaseBSocket(scope, `${NATIVE_ORIGIN.replace("https:", "wss:")}/api/projects/${id}/session`),
  );
  assert(!phaseBSocket(native, `wss://elsewhere.invalid/api/projects/${id}/terminal`));
  assert.throws(() => parsePhaseB({ ...native, workspaceId: id }));
  assert.throws(() => parsePhaseB({ ...native, origin: ORIGIN }));
  assert.throws(
    () =>
      parseScope({
        schemaVersion: 1,
        sourceRevision: native.sourceRevision,
        workspaceId: NATIVE_WORKSPACE,
        repositoryId: native.repositoryId,
        providerAccountId: native.providerAccountId,
        preflightDigest: native.preflightDigest,
        expectedAppVersion: native.expectedAppVersion,
        expectedAppBuild: native.expectedAppBuild,
        priorForwarded: 0,
      }),
    "Phase A must not admit the native target",
  );
});
test("native pilot keeps cumulative forwarding within its own 200-request ceiling", () => {
  const native = parsePhaseB({
    ...scope,
    workspaceId: NATIVE_WORKSPACE,
    priorForwarded: 31,
    incrementalBudget: 169,
  });
  assert.equal(phaseBHasBudget(native, 198), true);
  assert.equal(phaseBHasBudget(native, 199), false);
  assert.equal(phaseBHasBudget(native, 199, true), true);
  assert.equal(phaseBHasBudget(native, 200, true), false);
  assert.throws(() => parsePhaseB({ ...native, incrementalBudget: 170 }));
  assert.throws(() => parsePhaseB({ ...native, priorForwarded: 199, incrementalBudget: 2 }));
  assert.equal(
    parsePhaseB(scope).incrementalBudget,
    200,
    "legacy 148 prior requests use a separate allowance",
  );
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
