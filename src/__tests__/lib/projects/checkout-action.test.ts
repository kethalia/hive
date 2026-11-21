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
  cloneMissing: true,
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
  vi.stubEnv("HIVE_PROJECTS_ROOT", "/home/coder");
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
  const data = { fullName: "owner/repo", relativePath: "projects/owner/repo" };
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
        cloneMissing: true,
        projectsRoot: "/home/coder",
      }),
    }),
  );
});

it("reports a missing checkout during the check step without returning a terminal", async () => {
  mocks.execute.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ checkout: "missing" }),
  });
  expect((await openProjectTerminalAction({ ...target, cloneMissing: false }))?.data).toEqual({
    checkout: "missing",
  });
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

it("builds the terminal identity from the checkout path beneath the configured root", async () => {
  vi.stubEnv("HIVE_PROJECTS_ROOT", "/home/coder/projects");
  mocks.execute.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ fullName: "owner/.github", relativePath: "owner/.github" }),
  });
  expect((await openProjectTerminalAction(target))?.data).toMatchObject({
    cloneSessionKey: "git-clone:owner/.github",
    relativePath: "owner/.github",
  });
  expect(JSON.parse(mocks.execute.mock.lastCall?.[2].stdin)).toMatchObject({
    projectsRoot: "/home/coder/projects",
  });
});
