import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "@hive/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  AccessDenied,
  GrantConflict,
  readGrants,
  repositoryCredential,
} from "@/lib/projects/grants.server";
import { issueRepositoryToken, revokeInstallationToken } from "@/lib/projects/installation.server";

vi.mock("@/lib/projects/installation.server", () => ({
  issueRepositoryToken: vi.fn(async () => ({
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 3600000),
  })),
  revokeInstallationToken: vi.fn(async () => {}),
}));
const repos = [
  { id: 1183966024, name: "kethalia/hive", installationId: 101 },
  { id: 1371240353, name: "kethalia/codex-creative-studio", installationId: 101 },
  { id: 975000813, name: "chillwhales/lsp-indexer", installationId: 202 },
  { id: 846580864, name: "chillwhales/chillwhales-frontend", installationId: 202 },
];
const enabled = Boolean(process.env.HIVE_GRANTS_TEST_DATABASE);
beforeAll(() => {
  if (enabled) {
    vi.stubEnv("DATABASE_URL", process.env.HIVE_GRANTS_TEST_DATABASE!);
    vi.stubEnv("ENCRYPTION_KEY", "b1".repeat(32));
  }
});
afterAll(async () => {
  if (enabled) await closeDb();
  vi.unstubAllEnvs();
});
it.skipIf(!enabled)(
  "isolates four repository grants, serializes concurrent edits, and revokes live tokens on downgrade and removal",
  async () => {
    const id = randomUUID();
    const repo = repos[0];
    try {
      expect((await readGrants(id, repos)).map((r) => r.access)).toEqual([
        "none",
        "none",
        "none",
        "none",
      ]);
      await expect(repositoryCredential(id, repo)).rejects.toBeInstanceOf(AccessDenied);
      const concurrent = await Promise.allSettled(
        [1, 2].map(() => repositoryCredential(id, repo, { access: "write", revision: null })),
      );
      expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.find((r) => r.status === "rejected")).toMatchObject({
        reason: expect.any(GrantConflict),
      });
      const before = await repositoryCredential(id, repo);
      const [current] = await readGrants(id, repos);
      const after = await repositoryCredential(id, repo, {
        access: "read",
        revision: current.revision,
      });
      expect(revokeInstallationToken).toHaveBeenCalledWith(before.token);
      expect(issueRepositoryToken).toHaveBeenLastCalledWith(repo, "read");
      expect(after.token).not.toBe(before.token);
      await expect(repositoryCredential(id, repos[2])).rejects.toBeInstanceOf(AccessDenied);
      await expect(repositoryCredential(randomUUID(), repo)).rejects.toBeInstanceOf(AccessDenied);
      const [read] = await readGrants(id, repos);
      await repositoryCredential(id, repo, { access: "none", revision: read.revision });
      expect(revokeInstallationToken).toHaveBeenCalledWith(after.token);
      await expect(repositoryCredential(id, repo)).rejects.toBeInstanceOf(AccessDenied);
    } finally {
      await getDb().gitHubWorkspaceGrant.deleteMany({ where: { workspaceId: id } });
    }
  },
);
