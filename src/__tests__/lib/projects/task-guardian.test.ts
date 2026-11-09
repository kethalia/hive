import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  owner: vi.fn(),
  project: vi.fn(),
  provision: vi.fn(),
  host: vi.fn(),
  guardianStage: "" as string,
  payload: {} as Record<string, unknown>,
}));
vi.mock("@hive/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/db")>()),
  getDb: () => ({
    $queryRaw: async () => [],
    user: { findUnique: mock.owner },
    deliveryProject: { findUnique: mock.project },
    projectTaskIntent: { findUnique: async () => null },
  }),
}));
vi.mock("@/lib/codex-session/guardian-factory.server", () => ({
  createGuardianService: (options: { onProvisionStage?: (stage: string) => void }) => ({
    provision: (...args: unknown[]) => {
      if (mock.guardianStage) options.onProvisionStage?.(mock.guardianStage);
      return mock.provision(...args);
    },
  }),
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mock.host }));
vi.mock("@/lib/projects/task-intents.server", async (original) => ({
  ...(await original()),
  ProjectTaskIntents: class {},
  reconcileTaskIntents: async (
    _store: unknown,
    deliver: (payload: unknown, phase: string) => Promise<unknown>,
  ) => {
    await deliver(mock.payload, "queued");
    return { reconciled: 1 };
  },
}));

import { reconcileProjectTasks } from "@/lib/projects/task.server";

const ownerId = "11111111-1111-4111-8111-111111111111",
  projectId = "22222222-2222-4222-8222-222222222222",
  workspaceId = "33333333-3333-4333-8333-333333333333",
  taskId = "44444444-4444-4444-8444-444444444444";
beforeEach(() => {
  vi.resetAllMocks();
  mock.guardianStage = "";
  vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  mock.payload = {
    ownerId,
    projectId,
    workspaceId,
    taskId,
    repositoryId: "123",
    providerAccountId: "456",
    hostRequest: { fixture: "durably decoded task request" },
  };
  mock.owner.mockResolvedValue({ id: ownerId, coderUserId: "coder-owner" });
  mock.project.mockResolvedValue({
    id: projectId,
    ownerId,
    provider: "github",
    providerRepositoryId: "123",
    providerAccountId: "456",
  });
  mock.provision.mockResolvedValue({ runtimeId: "runtime", enrolled: true });
  mock.host.mockResolvedValue({
    schemaVersion: 1,
    projectId,
    taskId,
    phase: "preparing",
    nativeThreadId: null,
    terminalSessionName: null,
    reason: null,
  });
});
it.each([
  "guardian_config",
  "guardian_identity_transport",
  "guardian_identity_validation",
  "guardian_runtime_reservation",
])("persists only the reported trusted %s stage", async (stage) => {
  mock.guardianStage = stage;
  mock.provision.mockRejectedValueOnce(new Error("private credential"));
  await expect(reconcileProjectTasks()).rejects.toMatchObject({
    stage,
    message: "Task execution stage failed",
  });
});
afterEach(() => vi.unstubAllEnvs());

it("enrolls the independently verified owner runtime before sending durable preparation", async () => {
  await reconcileProjectTasks({ ownerId, taskId }, 1);
  expect(mock.provision).toHaveBeenCalledWith(
    { hiveUserId: ownerId, coderUserId: "coder-owner" },
    workspaceId,
  );
  expect(mock.host).toHaveBeenCalledWith(
    { id: ownerId, coderUserId: "coder-owner" },
    workspaceId,
    "/projects/tasks/start",
    mock.payload.hostRequest,
  );
  expect(mock.project.mock.invocationCallOrder[0]).toBeLessThan(
    mock.provision.mock.invocationCallOrder[0],
  );
  expect(mock.provision.mock.invocationCallOrder[0]).toBeLessThan(
    mock.host.mock.invocationCallOrder[0],
  );
});
it("failed or unconfirmed enrollment prevents checkout preparation", async () => {
  mock.provision.mockRejectedValueOnce(new Error("approved package changed"));
  await expect(reconcileProjectTasks()).rejects.toMatchObject({
    stage: "guardian",
    message: "Task execution stage failed",
  });
  mock.provision.mockResolvedValueOnce({ enrolled: false });
  await expect(reconcileProjectTasks()).rejects.toMatchObject({ stage: "guardian" });
  expect(mock.host).not.toHaveBeenCalled();
});
it("classifies host failures without retaining their private messages", async () => {
  mock.host.mockRejectedValueOnce(new Error("private bearer fixture"));
  await expect(reconcileProjectTasks()).rejects.toMatchObject({
    stage: "host_start",
    message: "Task execution stage failed",
  });
});
it("propagates cancellation into guardian and the fixed host transport", async () => {
  const controller = new AbortController();
  await reconcileProjectTasks(undefined, 1, { signal: controller.signal });
  expect(mock.host).toHaveBeenCalledWith(
    { id: ownerId, coderUserId: "coder-owner" },
    workspaceId,
    "/projects/tasks/start",
    mock.payload.hostRequest,
    { signal: controller.signal },
  );
});
it("discarded late enrollment cannot initiate host execution", async () => {
  const controller = new AbortController();
  mock.provision.mockImplementation(async () => {
    controller.abort();
    return { enrolled: true };
  });
  await expect(
    reconcileProjectTasks(undefined, 1, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(mock.host).not.toHaveBeenCalled();
});
it("owner/project mismatches reject before enrollment or host requests", async () => {
  mock.project.mockResolvedValueOnce(null);
  await expect(reconcileProjectTasks()).rejects.toThrow();
  mock.project.mockResolvedValueOnce({
    provider: "github",
    providerRepositoryId: "999",
    providerAccountId: "456",
  });
  await expect(reconcileProjectTasks()).rejects.toMatchObject({ stage: "project" });
  expect(mock.provision).not.toHaveBeenCalled();
  expect(mock.host).not.toHaveBeenCalled();
});
it("default-off legacy preparation does not enroll a guardian", async () => {
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "false");
  await reconcileProjectTasks();
  expect(mock.provision).not.toHaveBeenCalled();
  expect(mock.host).toHaveBeenCalledOnce();
});
