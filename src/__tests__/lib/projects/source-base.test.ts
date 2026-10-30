import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => vi.fn());
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: host }));

import type { ResolvedRepository } from "@/lib/projects/session-contracts";
import { resolveProjectSourceBase } from "@/lib/projects/source-base.server";
import { githubFixture } from "../delivery/github-fixture";

const user = { id: "11111111-1111-4111-8111-111111111111", coderUserId: "owner" };
const workspaceId = "33333333-3333-4333-8333-333333333333";
const resolved: ResolvedRepository = {
  schemaVersion: 1,
  providerAccountId: "456",
  defaultRevision: "a".repeat(40),
  repository: {
    provider: "github",
    providerRepositoryId: "123",
    nodeId: "repo",
    fullName: "owner/repo",
    owner: "owner",
    name: "repo",
    defaultBranch: "main",
    private: true,
    archived: false,
    htmlUrl: "https://github.com/owner/repo",
    permissions: { pull: true, push: true, admin: false },
  },
};
function catalog(branch = "codex/epic") {
  const evidenceGates = githubFixture().policy;
  evidenceGates.checks[0].criterionIds = ["repo:ci"];
  if (evidenceGates.codexReview) evidenceGates.codexReview.criterionIds = ["repo:review"];
  return [
    {
      ownerId: user.id,
      repositoryId: "123",
      providerAccountId: "456",
      fullName: "owner/repo",
      policy: {
        schemaVersion: 1,
        source: {
          version: "v1",
          authorName: "Fixture",
          authorEmail: "fixture@example.invalid",
          baseBranch: branch,
          allowedPrefixes: ["src"],
          maxFiles: 10,
          maxFileBytes: 1000,
          maxBytes: 10000,
        },
        evidenceGates,
        acceptanceContracts: [],
      },
    },
  ];
}
const result = {
  schemaVersion: 1,
  providerAccountId: "456",
  repository: resolved.repository,
  branch: "codex/epic",
  revision: "b".repeat(40),
};
beforeEach(() => {
  vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICIES_JSON", JSON.stringify(catalog()));
  host.mockReset().mockResolvedValue(result);
});
afterEach(() => vi.unstubAllEnvs());
describe("deployment-selected exact project source branch", () => {
  it("resolves the configured epic branch instead of the repository default", async () => {
    await expect(resolveProjectSourceBase(user, workspaceId, resolved)).resolves.toEqual({
      branch: "codex/epic",
      revision: "b".repeat(40),
    });
    expect(host).toHaveBeenCalledWith(user, workspaceId, "/projects/resolve-ref", {
      schemaVersion: 1,
      repositoryId: "123",
      expectedAccountId: "456",
      branch: "codex/epic",
    });
  });
  it("resolves even a default-branch policy through exact heads rather than commits expressions", async () => {
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICIES_JSON", JSON.stringify(catalog("main")));
    host.mockResolvedValue({ ...result, branch: "main" });
    await expect(resolveProjectSourceBase(user, workspaceId, resolved)).resolves.toEqual({
      branch: "main",
      revision: "b".repeat(40),
    });
    expect(host).toHaveBeenCalledTimes(1);
  });
  it.each([
    { branch: "main" },
    { providerAccountId: "999" },
    { revision: "HEAD" },
    { repository: { ...resolved.repository, providerRepositoryId: "124" } },
    { repository: { ...resolved.repository, fullName: "other/repo" } },
    { repository: { ...resolved.repository, archived: true } },
    {
      repository: {
        ...resolved.repository,
        permissions: { pull: true, push: false, admin: false },
      },
    },
  ])("rejects changed identity/ref/permissions: %j", async (patch) => {
    host.mockResolvedValue({ ...result, ...patch });
    await expect(resolveProjectSourceBase(user, workspaceId, resolved)).rejects.toThrow();
  });
  it("does not infer enrollment or accept absent catalog entries", async () => {
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICIES_JSON", "[]");
    await expect(resolveProjectSourceBase(user, workspaceId, resolved)).rejects.toThrow(
      "repository_policy_not_enrolled",
    );
    expect(host).not.toHaveBeenCalled();
  });
  it("retains legacy default source selection with enrollment disabled", async () => {
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED", "false");
    await expect(resolveProjectSourceBase(user, workspaceId, resolved)).resolves.toEqual({
      branch: "main",
      revision: resolved.defaultRevision,
    });
    expect(host).not.toHaveBeenCalled();
  });
});
