import assert from "node:assert/strict";
import test from "node:test";
import { ProjectSupervisor } from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

function fixture() {
  const source = { revisionId: "revision", version: 1, headSha: "a".repeat(40) };
  const application = {
    projectId: "project",
    applicationId: "application",
    serverInstanceId: "lifetime",
    managerThreadId: "root",
    phase: "reserved",
    targetSourceContext: source,
    barrier: { id: "barrier", generation: 2, closed: true },
    cohort: [{ childThreadId: "child", spawnCallId: "spawn" }],
  };
  const state = {
    status: "ready",
    serverInstanceId: "lifetime",
    projects: {
      project: {
        threadId: "root",
        serverInstanceId: "lifetime",
        sourceApplication: application,
        children: {
          child: { serverInstanceId: "lifetime", spawnCallId: "spawn" },
        },
      },
    },
  };
  const supervisor = new ProjectSupervisor(
    { projects: [{ projectId: "project" }] },
    "/unused",
    "/unused",
    state,
    () => {},
    null,
  );
  const calls = [];
  supervisor.runtime = {
    alive: () => true,
    readSourceApplication: async (...args) => {
      calls.push(args);
      return { data: [] };
    },
  };
  const scope = {
    projectId: "project",
    applicationId: "application",
    barrierId: "barrier",
    generation: 2,
  };
  return { supervisor, application, state, scope, source, calls };
}
test("pending source application blocks inputs while exact root/cohort factual reads remain available", async () => {
  const f = fixture();
  assert.throws(() => f.supervisor.assertSourceInputOpen(), /input_closed/);
  await assert.rejects(
    f.supervisor.command({ operation: "firstPrompt", projectId: "project" }),
    /input_closed/,
  );
  assert.deepEqual(
    await f.supervisor.readSourceApplication(f.scope, "thread/turns/list", {
      threadId: "child",
      limit: 100,
      sortDirection: "asc",
      itemsView: "full",
    }),
    { data: [] },
  );
  assert.equal(f.calls.length, 1);
});
test("read seam rejects execution methods, foreign threads, extra paths, stale generations and lost runtime", async () => {
  for (const [method, params] of [
    ["turn/start", { threadId: "root" }],
    ["thread/resume", { threadId: "root" }],
    ["command/exec", { command: ["true"] }],
    ["thread/read", { threadId: "foreign", includeTurns: true }],
    ["thread/read", { threadId: "root", includeTurns: true, cwd: "/arbitrary" }],
    ["thread/turns/list", { threadId: "root", limit: 101, sortDirection: "asc" }],
  ]) {
    const f = fixture();
    await assert.rejects(
      f.supervisor.readSourceApplication(f.scope, method, params),
      /read_denied/,
    );
    assert.equal(f.calls.length, 0);
  }
  for (const mutate of [
    (f) => {
      f.scope.generation++;
    },
    (f) => {
      f.state.serverInstanceId = "changed";
    },
    (f) => {
      f.state.status = "revoked";
    },
    (f) => {
      f.state.projects.project.children.child.spawnCallId = "changed";
    },
    (f) => {
      f.supervisor.config.projects.push({ projectId: "other" });
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      f.supervisor.readSourceApplication(f.scope, "thread/read", {
        threadId: "root",
        includeTurns: true,
      }),
      /read_denied/,
    );
  }
});
test("read result is discarded when application identity changes while awaiting the native response", async () => {
  const f = fixture();
  f.supervisor.runtime.readSourceApplication = async () => {
    f.application.barrier.generation++;
    return { data: ["stale"] };
  };
  await assert.rejects(
    f.supervisor.readSourceApplication(f.scope, "thread/loaded/list", { limit: 64 }),
    /read_denied/,
  );
});
test("metadata context changes alone do not reopen durable source inputs", () => {
  const f = fixture();
  f.state.projects.project.acceptedSource = f.source;
  f.application.phase = "applied";
  assert.throws(() => f.supervisor.assertSourceInputOpen(), /input_closed/);
  f.application.phase = "released";
  assert.throws(() => f.supervisor.assertSourceInputOpen(), /input_closed/);
  f.application.serverCommitDigest = "b".repeat(64);
  f.supervisor.assertSourceInputOpen();
  f.state.projects.project.acceptedSource = { ...f.source, version: 2 };
  assert.throws(() => f.supervisor.assertSourceInputOpen(), /input_closed/);
});
test("revocation-only seam interrupts exact mapped turns during source closure, replay never releases application", async () => {
  const f = fixture(),
    active = new Set(["root", "child"]),
    stopped = [];
  f.supervisor.runtime.call = async () => {
    throw new Error("ordinary_input_closed");
  };
  f.supervisor.runtime.readSourceApplication = async (_scope, method, params) => {
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: `turn-${params.threadId}`,
            status: active.has(params.threadId) ? "inProgress" : "interrupted",
          },
        ],
        nextCursor: null,
      };
    if (method === "thread/loaded/list") return { data: ["root", "child"] };
    if (method === "thread/read")
      return { thread: { id: params.threadId, status: { type: "idle" } } };
    throw new Error("unexpected");
  };
  f.supervisor.runtime.interruptSourceApplication = async (scope, params) => {
    f.supervisor.assertSourceApplicationStop(scope, params);
    stopped.push(params.threadId);
    active.delete(params.threadId);
    return {};
  };
  assert.throws(
    () =>
      f.supervisor.assertSourceApplicationStop(f.scope, { threadId: "root", turnId: "turn-root" }),
    /stop_denied/,
  );
  assert.equal((await f.supervisor.revokeExecution("project")).reviewRequired, false);
  assert.deepEqual(stopped, ["root", "child"]);
  await f.supervisor.revokeExecution("project");
  assert.deepEqual(stopped, ["root", "child"]);
  assert.throws(
    () =>
      f.supervisor.assertSourceApplicationStop(f.scope, {
        threadId: "foreign",
        turnId: "turn-foreign",
      }),
    /read_denied/,
  );
  assert.throws(() => f.supervisor.assertSourceInputOpen(), /input_closed/);
  assert.equal(f.application.phase, "reserved");
  const read = f.supervisor.runtime.readSourceApplication;
  f.supervisor.runtime.readSourceApplication = async (scope, method, params) =>
    method === "thread/loaded/list"
      ? { data: ["root", "child", "unknown"] }
      : read(scope, method, params);
  assert.equal((await f.supervisor.revokeExecution("project")).reviewRequired, true);
  assert.throws(() => f.supervisor.assertSourceInputOpen(), /input_closed/);
});
