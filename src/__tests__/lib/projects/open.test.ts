import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ host: vi.fn(), bind: vi.fn(), db: vi.fn() }));
vi.mock("@hive/db", () => ({ getDb: mock.db }));
vi.mock("@/lib/delivery/repository", () => ({
  DeliveryRepository: class {
    bindProject = mock.bind;
  },
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mock.host }));

import { openProject } from "@/lib/projects/open.server";

const user = { id: "11111111-1111-4111-8111-111111111111", coderUserId: "owner" };
const projectId = "22222222-2222-4222-8222-222222222222";
const input = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  repositoryId: "123",
  providerAccountId: "456",
  requestId: "44444444-4444-4444-8444-444444444444",
};
const resolved = {
  schemaVersion: 1,
  providerAccountId: "456",
  defaultRevision: "a".repeat(40),
  repository: {
    provider: "github",
    providerRepositoryId: "123",
    nodeId: "repo123",
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
beforeEach(() => {
  vi.clearAllMocks();
  mock.bind.mockResolvedValue({ id: projectId, fullName: "owner/repo" });
  mock.host.mockImplementation(async (_user, _workspace, path) =>
    path === "/projects/resolve"
      ? resolved
      : {
          ...resolved,
          projectId,
          phase: "awaitingTask",
          currentTaskId: null,
          nativeThreadId: null,
          terminalSessionName: null,
        },
  );
});
afterEach(() => vi.unstubAllEnvs());
describe("verified project enrollment", () => {
  it.each([
    "[]",
    "{",
    '[{"unexpected":true}]',
  ])("retains access to the project while delivery enrollment is unavailable: %s", async (catalog) => {
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED", "true");
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICIES_JSON", catalog);
    await expect(openProject(user, input)).resolves.toMatchObject({
      projectId,
      sourceBaseUnavailable: true,
    });
  });
  it("resolves current access before binding the canonical project and enrolling without task execution", async () => {
    const result = await openProject(user, input);
    expect(result).toMatchObject({
      projectId,
      phase: "awaitingTask",
      currentTaskId: null,
      nativeThreadId: null,
      terminalSessionName: null,
      workspaceId: input.workspaceId,
    });
    expect(mock.host.mock.calls.map((args) => args[2])).toEqual([
      "/projects/resolve",
      "/projects/open",
    ]);
    expect(mock.bind).toHaveBeenCalledWith(user.id, {
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "owner/repo",
    });
    expect(mock.host.mock.calls[1][3]).toEqual({
      schemaVersion: 1,
      projectId,
      repositoryId: "123",
      expectedAccountId: "456",
      requestId: input.requestId,
    });
  });
  it.each([
    { ...resolved, providerAccountId: "999" },
    { ...resolved, repository: { ...resolved.repository, providerRepositoryId: "999" } },
    {
      ...resolved,
      repository: {
        ...resolved.repository,
        permissions: { pull: false, push: false, admin: false },
      },
    },
  ])("rejects substituted identity or revoked read access before persistence", async (reply) => {
    mock.host.mockResolvedValue(reply);
    await expect(openProject(user, input)).rejects.toThrow();
    expect(mock.bind).not.toHaveBeenCalled();
    expect(mock.host).toHaveBeenCalledTimes(1);
  });
  it("retains canonical project identity when the repository is renamed between verified calls", async () => {
    const renamed = {
      ...resolved.repository,
      name: "renamed",
      fullName: "owner/renamed",
      htmlUrl: "https://github.com/owner/renamed",
    };
    mock.host.mockResolvedValueOnce(resolved).mockResolvedValueOnce({
      ...resolved,
      repository: renamed,
      projectId,
      phase: "awaitingTask",
      currentTaskId: null,
      nativeThreadId: null,
      terminalSessionName: null,
    });
    expect((await openProject(user, input)).repository.fullName).toBe("owner/renamed");
    expect(mock.bind.mock.calls[1][1].fullName).toBe("owner/renamed");
  });
  it("never returns substituted enrollment identity or private helper errors", async () => {
    mock.host.mockResolvedValueOnce(resolved).mockResolvedValueOnce({
      ...resolved,
      projectId: input.requestId,
      phase: "awaitingTask",
      currentTaskId: null,
      nativeThreadId: null,
      terminalSessionName: null,
    });
    await expect(openProject(user, input)).rejects.toMatchObject({
      code: "github_invalid_response",
    });
  });
  it("rejects caller-owned path, URL and project IDs before any remote request", async () => {
    await expect(openProject(user, { ...input, projectId, path: "/tmp/repo" })).rejects.toThrow();
    expect(mock.host).not.toHaveBeenCalled();
  });
});
