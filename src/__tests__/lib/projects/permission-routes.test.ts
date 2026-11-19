import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as manage } from "@/app/api/github/permissions/route";
import { POST as issue } from "@/app/api/github/workspace-token/route";
import { getRequestSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { readGrants, repositoryCredential } from "@/lib/projects/grants.server";

vi.mock("@hive/db", () => ({
  getDb: () => ({ user: { findUnique: async () => ({ id: "hive-user", coderUserId: ownerId }) } }),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: vi.fn() }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));
vi.mock("@/lib/projects/grants.server", () => ({
  readGrants: vi.fn(),
  repositoryCredential: vi.fn(),
  GrantConflict: class extends Error {},
  AccessDenied: class extends Error {},
}));
const workspaceId = "00000000-0000-4000-8000-000000000001",
  ownerId = "00000000-0000-4000-8000-000000000002",
  templateId = "00000000-0000-4000-8000-000000000003",
  key = "A".repeat(43),
  origin = "https://hive.example";
const repo = { id: 1183966024, name: "kethalia/hive", installationId: 101 };
const request = (body: object, headers: Record<string, string>) =>
  new Request(origin + "/api/github/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.stubEnv("CODER_URL", "https://coder.example");
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  vi.stubEnv(
    "HIVE_GITHUB_APP_WORKSPACES",
    JSON.stringify({
      [workspaceId]: {
        ownerId,
        templateId,
        keyHash: createHash("sha256").update(key).digest("hex"),
        repositories: [repo],
      },
    }),
  );
  vi.mocked(getRequestSession).mockResolvedValue({
    user: { id: "hive-user", coderUserId: ownerId },
  } as Awaited<ReturnType<typeof getRequestSession>>);
  vi.mocked(getCoderClientForUser).mockResolvedValue({
    getWorkspace: async () => ({
      id: workspaceId,
      owner_id: ownerId,
      latest_build: { status: "running" },
      template_id: templateId,
    }),
  } as unknown as Awaited<ReturnType<typeof getCoderClientForUser>>);
  vi.mocked(repositoryCredential).mockResolvedValue({ token: "test-confidential", access: "read" });
  vi.mocked(readGrants).mockResolvedValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
it("only the workspace owner can edit an enrolled repository and the browser receives no token", async () => {
  const change = { repoId: repo.id, access: "read", revision: null };
  expect(
    (await manage(request({ workspaceId, change }, { origin: "https://other.example" }))).status,
  ).toBe(403);
  expect(
    (await manage(request({ workspaceId, change: { ...change, repoId: 99 } }, { origin }))).status,
  ).toBe(403);
  expect(repositoryCredential).not.toHaveBeenCalled();
  const res = await manage(request({ workspaceId, change }, { origin }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ managed: true, repositories: [] });
  vi.mocked(getRequestSession).mockResolvedValue({
    user: { id: "other", coderUserId: "other" },
  } as Awaited<ReturnType<typeof getRequestSession>>);
  expect((await manage(request({ workspaceId, change }, { origin }))).status).toBe(403);
});
it("requires a workspace-specific bearer and immutable catalog entry for terminal issuance", async () => {
  const body = { workspaceId, repository: repo.name },
    authorization = "Bearer " + key;
  expect((await issue(request(body, { authorization, origin }))).status).toBe(403);
  expect((await issue(request(body, { authorization: "Bearer " + "B".repeat(43) }))).status).toBe(
    403,
  );
  expect(
    (await issue(request({ ...body, repository: "chillwhales/lsp-indexer" }, { authorization })))
      .status,
  ).toBe(403);
  expect(repositoryCredential).not.toHaveBeenCalled();
  const res = await issue(request(body, { authorization }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ token: "test-confidential" });
});
