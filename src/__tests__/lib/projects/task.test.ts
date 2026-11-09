import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sourceBaseModule from "@/lib/projects/source-base.server";

const mock = vi.hoisted(() => ({
  host: vi.fn(),
  project: vi.fn(),
  slot: vi.fn(),
  registration: vi.fn(),
  provision: vi.fn(),
  resolve: vi.fn(),
  enqueue: vi.fn(),
  holdWake: vi.fn(),
  intent: vi.fn(),
  snapshot: vi.fn(),
  recover: vi.fn(),
  get: vi.fn(),
  transaction: vi.fn(),
  policyAuthorize: vi.fn(),
  recoveryBegin: vi.fn(),
  recoveryAuthorize: vi.fn(),
  recoveryFinish: vi.fn(),
  guardianProvision: vi.fn(),
  guardianIdentity: vi.fn(),
  guardianResumption: vi.fn(),
  guardianContinuity: vi.fn(),
}));
vi.mock("@hive/db", () => ({
  getDb: () => ({
    deliveryProject: { findUnique: mock.project },
    projectTaskIntent: { findUnique: mock.intent },
    codexHostSlot: { findUnique: mock.slot },
    codexHostRegistration: { findUnique: mock.registration },
    $transaction: mock.transaction,
  }),
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mock.host }));
vi.mock("@/lib/delivery/repository-policy.server", () => ({
  repositoryPolicyStore: () => ({ authorizeIntent: mock.policyAuthorize }),
}));

vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: async () => "coder" }));
vi.mock("@/lib/codex-session/bootstrap-delivery.server", () => ({
  provisionRegisteredHost: mock.provision,
}));
vi.mock("@/lib/codex-session/registration.server", () => ({
  resolveVerifiedWorkspaceHost: mock.resolve,
}));
vi.mock("@/lib/codex-session/registered-session.server", () => ({
  registeredSessionConfig: () => ({}),
  createRegisteredSessionService: () => ({ authority: "authority" }),
}));

vi.mock("@/lib/projects/task-recovery-store.server", () => ({
  ProjectTaskRecoveries: class {
    begin = mock.recoveryBegin;
    authorize = mock.recoveryAuthorize;
    finish = mock.recoveryFinish;
  },
}));
vi.mock("@/lib/codex-session/guardian-factory.server", () => ({
  createGuardianService: () => ({
    provision: mock.guardianProvision,
    unusedRecoveryResumption: mock.guardianResumption,
    recoveryContinuity: mock.guardianContinuity,
    verifyRecoveryIdentity: mock.guardianIdentity,
  }),
}));
vi.mock("@/lib/projects/task-intents.server", async (original) => ({
  ...(await original()),
  ProjectTaskIntents: class {
    enqueue = mock.enqueue;
    holdWake = mock.holdWake;
    recoverySnapshot = mock.snapshot;
    recover = mock.recover;
    get = mock.get;
  },
}));

import {
  projectTaskId,
  readHostProjectTask as readProjectTask,
  retryProjectTask,
  startProjectTask,
} from "@/lib/projects/task.server";

const user = { id: "11111111-1111-4111-8111-111111111111", coderUserId: "owner" };
const projectId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const taskId = projectTaskId(user.id, projectId, requestId);
const project = {
  id: projectId,
  ownerId: user.id,
  provider: "github",
  providerRepositoryId: "123",
  providerAccountId: "456",
};
const resolved = {
  schemaVersion: 1,
  providerAccountId: "456",
  defaultRevision: "a".repeat(40),
  repository: {
    provider: "github",
    providerRepositoryId: "123",
    nodeId: "repo",
    fullName: "owner/repo",
    name: "repo",
    owner: "owner",
    defaultBranch: "main",
    private: true,
    archived: false,
    htmlUrl: "https://github.com/owner/repo",
    permissions: { pull: true, push: true, admin: false },
  },
};
const result = {
  schemaVersion: 1,
  projectId,
  taskId,
  phase: "preparing",
  nativeThreadId: null,
  terminalSessionName: null,
  reason: null,
};
const input = { workspaceId, requestId, expectedRevision: "a".repeat(40), text: "Fix the bug" };
beforeEach(() => {
  vi.clearAllMocks();
  mock.guardianResumption.mockResolvedValue(undefined);
  mock.guardianContinuity.mockResolvedValue(undefined);
  vi.stubEnv("HIVE_CODEX_MANAGER_MODEL", "fixture-model");
  vi.stubEnv("HIVE_CODEX_MANAGER_EFFORT", "high");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  mock.transaction.mockImplementation((work) => work({}));
  mock.policyAuthorize.mockResolvedValue(null);
  mock.enqueue.mockResolvedValue({ id: taskId, projectId, phase: "queued", status: null });
  mock.intent.mockResolvedValue(null);
  mock.project.mockResolvedValue(project);
  mock.slot.mockResolvedValue(null);
  mock.provision.mockResolvedValue({});
  mock.host.mockImplementation(async (_user, _workspace, path) =>
    path === "/projects/resolve" ? resolved : result,
  );
  mock.resolve.mockResolvedValue({
    binding: {
      coderOrigin: "https://coder.fixture.invalid",
      workspaceId,
      agentId: "agent",
      buildId: "build",
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("project task controller", () => {
  it("reports the actual failing start stage without exposing its error", async () => {
    const stages: string[] = [];
    mock.host.mockRejectedValue(new Error("private credential"));
    await expect(
      startProjectTask(user, projectId, input, (stage) => stages.push(stage)),
    ).rejects.toThrow();
    expect(stages).toEqual(["validation", "project", "existing_intent", "repository"]);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });

  it("pins the independently resolved policy base and rejects a stale displayed revision before enqueue", async () => {
    vi.spyOn(sourceBaseModule, "resolveProjectSourceBase").mockResolvedValue({
      branch: "codex/epic",
      revision: "b".repeat(40),
    });
    await expect(startProjectTask(user, projectId, input)).rejects.toThrow("source_changed");
    expect(mock.enqueue).not.toHaveBeenCalled();
    await startProjectTask(user, projectId, { ...input, expectedRevision: "b".repeat(40) });
    expect(mock.enqueue.mock.calls[0][0].hostRequest.revision).toBe("b".repeat(40));
  });
  it("owner recovery sends only the fixed existing-task identity and does not enqueue or resubmit a prompt", async () => {
    const row = {
      id: taskId,
      projectId,
      workspaceId,
      phase: "blocked",
      repositoryId: "123",
      providerAccountId: "456",
      status: { ...result, phase: "blocked", reason: "native_unavailable" },
    };
    const snapshot = { row, version: "exact-db-version" };
    mock.snapshot.mockResolvedValue(snapshot);
    mock.get.mockResolvedValue({ ...row, phase: "preparing", status: result });
    const request = { workspaceId, taskId, requestId };
    expect(await retryProjectTask(user, projectId, request)).toEqual(result);
    expect(mock.snapshot).toHaveBeenCalledWith(user.id, projectId, taskId, workspaceId);
    expect(mock.host).toHaveBeenCalledWith(user, workspaceId, "/projects/tasks/retry", {
      schemaVersion: 1,
      projectId,
      taskId,
      requestId,
    });
    expect(mock.recover).toHaveBeenCalledWith(snapshot, result);
    expect(mock.enqueue).not.toHaveBeenCalled();
    await expect(
      retryProjectTask(user, projectId, { ...request, text: "replacement prompt" }),
    ).rejects.toThrow();
    mock.host.mockClear();
    mock.snapshot.mockResolvedValue({
      ...snapshot,
      row: { ...row, phase: "running", status: { ...result, phase: "running" } },
    });
    expect((await retryProjectTask(user, projectId, request)).phase).toBe("running");
    expect(mock.host).not.toHaveBeenCalled();
  });
  it("isolates deterministic task intent by owner, project and original request", async () => {
    expect(projectTaskId(user.id, projectId, requestId)).toBe(taskId);
    expect(projectTaskId("other", projectId, requestId)).not.toBe(taskId);
    expect(projectTaskId(user.id, workspaceId, requestId)).not.toBe(taskId);
    expect(await startProjectTask(user, projectId, input)).toEqual(result);
    expect(mock.enqueue.mock.calls[0][0].hostRequest).toMatchObject({
      taskId,
      revision: input.expectedRevision,
      model: "fixture-model",
      effort: "high",
      text: input.text,
    });
  });
  it("flag-off does not downgrade an already-enrolled repository to a new unbound intent", async () => {
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED", "false");
    mock.project.mockResolvedValue({ ...project, repositoryPolicy: { id: projectId } });
    await expect(startProjectTask(user, projectId, input)).rejects.toThrow(
      "repository_policy_disabled",
    );
    expect(mock.enqueue).not.toHaveBeenCalled();
    expect(mock.host.mock.calls.every((call) => call[2] === "/projects/resolve")).toBe(true);
  });
  it("retry and host status reauthorize an old unbound intent when its repository is now enrolled", async () => {
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED", "false");
    mock.intent.mockResolvedValue({ id: taskId, projectId, repositoryPolicyVersionId: null });
    mock.project.mockResolvedValue({ ...project, repositoryPolicy: { id: projectId } });
    mock.policyAuthorize.mockRejectedValue(new Error("repository_policy_intent_unbound"));
    const request = { workspaceId, taskId, requestId };
    await expect(retryProjectTask(user, projectId, request)).rejects.toThrow(
      "repository_policy_intent_unbound",
    );
    await expect(readProjectTask(user, projectId, request)).rejects.toThrow(
      "repository_policy_intent_unbound",
    );
    expect(mock.policyAuthorize).toHaveBeenCalledTimes(2);
    expect(mock.policyAuthorize).toHaveBeenCalledWith({}, user.id, taskId);
    expect(mock.host).not.toHaveBeenCalled();
    expect(mock.snapshot).not.toHaveBeenCalled();
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("replays an accepted intent without re-resolving an advanced repository head", async () => {
    const { taskRequestDigest } = await import("@/lib/projects/task-intents.server");
    mock.intent.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      requestId,
      requestDigest: taskRequestDigest([
        user.id,
        projectId,
        workspaceId,
        requestId,
        input.expectedRevision,
        input.text,
      ]),
      phase: "running",
      status: { ...result, phase: "running" },
    });
    expect((await startProjectTask(user, projectId, input)).phase).toBe("running");
    expect(mock.host).not.toHaveBeenCalled();
    await expect(
      startProjectTask(user, projectId, { ...input, text: "different task" }),
    ).rejects.toThrow("task_identity_conflict");
    expect(mock.host).not.toHaveBeenCalled();
  });
  it("does not access host capabilities for another owner's project", async () => {
    mock.project.mockResolvedValue(null);
    await expect(startProjectTask(user, projectId, input)).rejects.toThrow();
    expect(mock.project).toHaveBeenCalledWith({
      where: { ownerId_id: { ownerId: user.id, id: projectId } },
      include: { repositoryPolicy: { select: { id: true } } },
    });
    expect(mock.host).not.toHaveBeenCalled();
  });
  it("rejects stale source and write revocation before executing", async () => {
    mock.host.mockResolvedValueOnce({ ...resolved, defaultRevision: "b".repeat(40) });
    await expect(startProjectTask(user, projectId, input)).rejects.toThrow("source_changed");
    expect(mock.host).toHaveBeenCalledTimes(1);
    mock.host.mockClear().mockResolvedValueOnce({
      ...resolved,
      repository: { ...resolved.repository, archived: true },
    });
    await expect(startProjectTask(user, projectId, input)).rejects.toMatchObject({
      code: "github_permission_denied",
    });
    expect(mock.host).toHaveBeenCalledTimes(1);
  });
  it("rejects caller runtime settings and limits prompt bytes before remote work", async () => {
    await expect(
      startProjectTask(user, projectId, { ...input, model: "promoted" }),
    ).rejects.toThrow();
    await expect(
      startProjectTask(user, projectId, { ...input, text: "😀".repeat(8193) }),
    ).rejects.toThrow();
    expect(mock.host).not.toHaveBeenCalled();
  });
  it("does not provision running tasks or accept mismatched task responses", async () => {
    mock.host.mockResolvedValue({ ...result, phase: "running" });
    expect((await readProjectTask(user, projectId, { workspaceId, requestId, taskId })).phase).toBe(
      "running",
    );
    expect(mock.provision).not.toHaveBeenCalled();
    mock.host.mockResolvedValue({ ...result, taskId: requestId });
    await expect(
      readProjectTask(user, projectId, { workspaceId, requestId, taskId }),
    ).rejects.toThrow();
    expect(mock.provision).not.toHaveBeenCalled();
  });
  it("provisions only the exact verified host and current registration's bounded project membership", async () => {
    mock.host
      .mockResolvedValueOnce({ ...result, phase: "awaitingRegistration" })
      .mockResolvedValueOnce({ ...result, phase: "running" });
    mock.slot.mockResolvedValue({ activeRegistrationId: "prior" });
    mock.registration.mockResolvedValue({
      buildId: "build",
      revokedAt: null,
      threads: [{ projectId: requestId }],
    });
    expect((await readProjectTask(user, projectId, { workspaceId, requestId, taskId })).phase).toBe(
      "running",
    );
    expect(mock.provision).toHaveBeenCalledWith(
      "authority",
      "coder",
      { hiveUserId: user.id, coderUserId: user.coderUserId },
      workspaceId,
      "agent",
      [requestId, projectId],
    );
  });
});

it.each([
  false,
  true,
])("guarded owner recovery stages inspection and CAS before consume and resumes ACK loss; explicit resumption %s", async (resuming) => {
  const { guardianDigest } = await import("@/lib/codex-session/guardian-contracts");
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  const coderUserId = "55555555-5555-4555-8555-555555555555",
    buildId = "66666666-6666-4666-8666-666666666666",
    lifetimeId = "77777777-7777-4777-8777-777777777777";
  const scope = {
    recoveryId: requestId,
    ownerId: user.id,
    coderOwnerId: coderUserId,
    projectId,
    taskId,
    workspaceId,
    originalRequestId: requestId,
    intentVersion: "v1",
    intentDigest: "a".repeat(64),
    hostRequestDigest: "b".repeat(64),
    repositoryId: "123",
    providerAccountId: "456",
    revision: "c".repeat(40),
  };
  const inspection = {
    outcome: resuming ? "existing_preexecution" : "task_absent",
    taskFingerprint: "d".repeat(64),
    buildId,
    lifetimeId,
    guardianGeneration: 1,
  };
  const identity = { identity: { lifetimeId }, startup: { generation: 1 } },
    runtime = { id: "runtime" };
  const authorization = {
    inspectionDigest: guardianDigest(inspection),
    authorizedVersion: "v2",
    buildId,
    lifetimeId,
    expiresAt: Date.now() + 30000,
  };
  const initial = { id: requestId, phase: "inspecting", scope },
    authorized = { ...initial, phase: "authorized", inspection, authorization };
  mock.snapshot.mockResolvedValue({
    row: {
      id: taskId,
      projectId,
      workspaceId,
      phase: "blocked",
      repositoryId: "123",
      providerAccountId: "456",
    },
    version: "v1",
  });
  mock.get.mockResolvedValue({ id: taskId, projectId, phase: "queued", status: null });
  mock.recoveryBegin.mockResolvedValue(initial);
  mock.recoveryAuthorize.mockResolvedValue(authorized);
  mock.guardianIdentity.mockResolvedValue({ runtime, packet: identity });
  const ticket = { attestationDigest: "e".repeat(64), expiresAt: Date.now() + 60000 };
  if (resuming) mock.guardianResumption.mockResolvedValue(ticket);
  mock.host.mockImplementation(async (_u, _w, path) =>
    path.endsWith("inspect")
      ? { schemaVersion: 1, scope, inspection, identity }
      : { receipt: true },
  );
  await retryProjectTask({ ...user, coderUserId }, projectId, { workspaceId, taskId, requestId });
  expect(mock.guardianIdentity).toHaveBeenCalledWith(
    { hiveUserId: user.id, coderUserId },
    workspaceId,
    identity,
    guardianDigest({ scope, inspection }),
    resuming ? { scope, inspection, authorize: expect.any(Function) } : undefined,
  );
  if (resuming) {
    expect(mock.guardianProvision).not.toHaveBeenCalled();
    expect(mock.guardianContinuity).not.toHaveBeenCalled();
    expect(mock.host.mock.calls[0][3]).toEqual({ schemaVersion: 1, scope, continuity: ticket });
    expect(mock.host.mock.invocationCallOrder[0]).toBeLessThan(
      mock.guardianIdentity.mock.invocationCallOrder[0],
    );
    const tx = { projectTaskIntent: { findUnique: vi.fn().mockResolvedValue(null) } };
    await mock.guardianIdentity.mock.calls[0][4].authorize(tx);
    expect(tx.projectTaskIntent.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { ownerId_id: { ownerId: user.id, id: taskId } },
    });
  }
  expect(mock.recoveryAuthorize.mock.invocationCallOrder[0]).toBeLessThan(
    mock.host.mock.invocationCallOrder[1],
  );
  expect(mock.host.mock.calls[1]).toEqual([
    { ...user, coderUserId },
    workspaceId,
    "/projects/tasks/recovery-consume",
    { schemaVersion: 1, scope, authorization },
    { expectedBuildId: buildId },
  ]);
  expect(JSON.stringify(mock.host.mock.calls)).not.toContain(input.text);
  expect(mock.enqueue).not.toHaveBeenCalled();
  mock.host.mockClear();
  mock.guardianProvision.mockClear();
  mock.recoveryBegin.mockResolvedValue(authorized);
  await retryProjectTask({ ...user, coderUserId }, projectId, { workspaceId, taskId, requestId });
  expect(mock.host).toHaveBeenCalledTimes(1);
  expect(mock.host.mock.calls[0][2]).toBe("/projects/tasks/recovery-consume");
  expect(mock.guardianProvision).not.toHaveBeenCalled();
});

it("retries a persisted authorized recovery directly after an admission/fence transport failure", async () => {
  const { guardianDigest } = await import("@/lib/codex-session/guardian-contracts");
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  const coderUserId = "55555555-5555-4555-8555-555555555555";
  const scope = {
    recoveryId: requestId,
    ownerId: user.id,
    coderOwnerId: coderUserId,
    projectId,
    taskId,
    workspaceId,
    originalRequestId: requestId,
    intentVersion: "original-blocked-version",
    intentDigest: "a".repeat(64),
    hostRequestDigest: "b".repeat(64),
    repositoryId: "123",
    providerAccountId: "456",
    revision: "c".repeat(40),
  };
  const inspection = {
    outcome: "existing_preexecution",
    taskFingerprint: "d".repeat(64),
    buildId: "66666666-6666-4666-8666-666666666666",
    lifetimeId: "77777777-7777-4777-8777-777777777777",
    guardianGeneration: 1,
  };
  const authorization = {
    inspectionDigest: guardianDigest(inspection),
    authorizedVersion: "persisted-authorized-version",
    buildId: inspection.buildId,
    lifetimeId: inspection.lifetimeId,
    expiresAt: Date.now() + 30000,
  };
  const authorized = { id: requestId, phase: "authorized", scope, inspection, authorization };
  const before = JSON.stringify(authorized);
  mock.snapshot.mockResolvedValue({
    row: {
      id: taskId,
      projectId,
      workspaceId,
      phase: "preparing",
      repositoryId: "123",
      providerAccountId: "456",
    },
    version: authorization.authorizedVersion,
  });
  mock.get.mockResolvedValue({ id: taskId, projectId, phase: "preparing", status: null });
  mock.recoveryBegin.mockResolvedValue(authorized);
  mock.host.mockRejectedValueOnce(new Error("synthetic admission/fence outcome unknown"));
  const principal = { ...user, coderUserId },
    request = { workspaceId, taskId, requestId };
  await expect(retryProjectTask(principal, projectId, request)).rejects.toThrow();
  expect(mock.recoveryFinish).not.toHaveBeenCalled();
  const receipt = { receipt: "same-authorized-recovery-ack" };
  mock.host.mockResolvedValueOnce(receipt);
  expect((await retryProjectTask(principal, projectId, request)).phase).toBe("preparing");
  expect(mock.host.mock.calls).toEqual(
    [0, 1].map(() => [
      principal,
      workspaceId,
      "/projects/tasks/recovery-consume",
      { schemaVersion: 1, scope, authorization },
      { expectedBuildId: authorization.buildId },
    ]),
  );
  expect(mock.guardianProvision).not.toHaveBeenCalled();
  expect(mock.guardianIdentity).not.toHaveBeenCalled();
  expect(mock.recoveryAuthorize).not.toHaveBeenCalled();
  expect(mock.recoveryFinish).toHaveBeenCalledExactlyOnceWith(authorized, receipt);
  expect(mock.enqueue).not.toHaveBeenCalled();
  expect(JSON.stringify(authorized)).toBe(before);
  expect(JSON.stringify(mock.host.mock.calls)).not.toContain(input.text);
});

describe("durable wake before accepted enqueue", () => {
  async function environment() {
    const { withTaskWakeEnvironment } = await import("@/lib/projects/task-wake.server");
    const identity = { ownerId: user.id, projectId, taskId },
      createdAt = Date.now();
    const reserve = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      ...identity,
      createdAt,
      deadline: createdAt + 1800000,
      requests: 1,
      attempts: 0,
      phase: "active",
      nextWake: createdAt + 1000,
      inFlightUntil: 0,
    });
    return {
      reserve,
      run: <T>(operation: () => T) =>
        withTaskWakeEnvironment(
          {
            HIVE_NATIVE_MODE: "preview",
            HIVE_NATIVE_PREVIEW_ENABLED: "true",
            HIVE_PROJECT_TASK_WAKE_ENABLED: "true",
            HIVE_PROJECT_TASK_WAKE_TASK_JSON: JSON.stringify(identity),
            HIVE_PROJECT_TASK_WAKE: { getByName: () => ({ reserve, inspect: reserve }) },
          },
          operation,
        ),
    };
  }
  it("requires durable acknowledgement before enqueue and includes lost-ACK accepted replay", async () => {
    const f = await environment();
    await f.run(() => startProjectTask(user, projectId, input));
    expect(f.reserve).toHaveBeenCalledOnce();
    expect(f.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mock.enqueue.mock.invocationCallOrder[0],
    );
    expect(mock.enqueue.mock.calls[0][1]).toBeGreaterThan(Date.now());
    const { taskRequestDigest } = await import("@/lib/projects/task-intents.server");
    mock.intent.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      requestId,
      requestDigest: taskRequestDigest([
        user.id,
        projectId,
        workspaceId,
        requestId,
        input.expectedRevision,
        input.text,
      ]),
      phase: "queued",
      status: null,
    });
    await f.run(() => startProjectTask(user, projectId, input));
    expect(f.reserve).toHaveBeenCalledTimes(2);
    expect(mock.enqueue).toHaveBeenCalledOnce();
  });
  it("accepted replay keeps an already running result after durable handoff", async () => {
    const f = await environment();
    const { taskRequestDigest } = await import("@/lib/projects/task-intents.server");
    const running = { ...result, phase: "running" as const, nativeThreadId: "retained-thread" };
    mock.intent.mockResolvedValue({
      id: taskId,
      projectId,
      workspaceId,
      requestId,
      requestDigest: taskRequestDigest([
        user.id,
        projectId,
        workspaceId,
        requestId,
        input.expectedRevision,
        input.text,
      ]),
      phase: "running",
      status: running,
    });
    mock.get.mockResolvedValue({ id: taskId, projectId, phase: "running", status: running });
    f.reserve.mockResolvedValue({ ...(await f.reserve()), phase: "running" });
    expect(await f.run(() => startProjectTask(user, projectId, input))).toEqual(running);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("does not enqueue or retry after an unknown reservation acknowledgement", async () => {
    const f = await environment();
    f.reserve.mockRejectedValue(new Error("unknown_ack"));
    await expect(f.run(() => startProjectTask(user, projectId, input))).rejects.toThrow(
      "unknown_ack",
    );
    expect(f.reserve).toHaveBeenCalledOnce();
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
});
