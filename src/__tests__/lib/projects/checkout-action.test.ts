import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openProjectTerminalAction } from "@/lib/actions/project-checkout";

const mocks = vi.hoisted(() => ({ session: vi.fn(), client: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mocks.client }));
vi.mock("@/lib/discovery/server-cache", () => ({
  discoveryCacheKey: vi.fn(),
  invalidateDiscovery: vi.fn(),
}));
vi.mock("@/lib/workspace/exec", () => ({ execInWorkspace: mocks.execute }));

const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  buildId: "22222222-2222-4222-8222-222222222222",
  providerAccountId: "12",
  repositoryId: "34",
};
const workspace = {
  id: target.workspaceId,
  name: "test-dev",
  owner_id: "coder-user",
  latest_build: { id: target.buildId, status: "running" },
};
const getWorkspace = vi.fn();
const getWorkspaceResources = vi.fn();

beforeEach(() => {
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  mocks.session.mockResolvedValue({ user: { id: "hive-user", coderUserId: "coder-user" } });
  mocks.client.mockResolvedValue({
    getWorkspace,
    getWorkspaceResources,
    getBaseUrl: () => "https://coder.example",
    getSessionToken: () => "fixture",
    getCredentialSource: () => "oauth",
  });
  getWorkspace.mockResolvedValue(workspace);
  getWorkspaceResources.mockResolvedValue([
    { agents: [{ id: "agent", name: "main", status: "connected" }] },
  ]);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("passes only the verified Coder build and stable GitHub identities to the workspace", async () => {
  const data = { fullName: "owner/repo" };
  mocks.execute.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(data) });
  expect((await openProjectTerminalAction(target))?.data).toMatchObject({
    kind: "terminal",
    workspaceId: target.workspaceId,
    label: "owner/repo",
    relativePath: "projects/owner/repo",
    sessionName: expect.stringMatching(/^git-clone-[a-f0-9]{32}$/),
  });
  expect(mocks.execute).toHaveBeenCalledWith(
    "test-dev.main",
    expect.any(String),
    expect.objectContaining({
      expected: { workspaceId: target.workspaceId, buildId: target.buildId, agentId: "agent" },
      stdin: JSON.stringify({
        workspaceId: target.workspaceId,
        buildId: target.buildId,
        repositoryId: target.repositoryId,
        providerAccountId: target.providerAccountId,
      }),
    }),
  );
});

it("rejects other owners, changed builds, and caller-provided checkout paths before workspace execution", async () => {
  getWorkspace.mockResolvedValueOnce({ ...workspace, owner_id: "other-user" });
  expect((await openProjectTerminalAction(target))?.serverError).toContain("workspace you own");
  getWorkspace.mockResolvedValueOnce({
    ...workspace,
    latest_build: { id: "changed", status: "running" },
  });
  expect((await openProjectTerminalAction(target))?.serverError).toContain(
    "workspace build changed",
  );
  const invalid = { ...target, checkout: "/home/coder/projects/existing" };
  expect((await openProjectTerminalAction(invalid))?.validationErrors).toBeDefined();
  expect(mocks.execute).not.toHaveBeenCalled();
});
