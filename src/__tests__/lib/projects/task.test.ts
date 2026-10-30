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
  intent: vi.fn(),
  snapshot: vi.fn(),
  recover: vi.fn(),
  get: vi.fn(),
  transaction: vi.fn(),
  policyAuthorize: vi.fn(),
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

vi.mock("@/lib/projects/task-intents.server", async (original) => ({
  ...(await original()),
  ProjectTaskIntents: class {
    enqueue = mock.enqueue;
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
