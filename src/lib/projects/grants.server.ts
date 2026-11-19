import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@hive/auth";
import { getDb } from "@hive/db";
import {
  type InstallationRepository,
  issueRepositoryToken,
  revokeInstallationToken,
} from "./installation.server";
import type { AccessLevel } from "./permissions";

export class GrantConflict extends Error {}
export class AccessDenied extends Error {}

function seal(secret: string) {
  const data = encrypt(secret, process.env.ENCRYPTION_KEY ?? "");
  return [data.ciphertext, data.iv, data.authTag]
    .map((bytes) => Buffer.from(bytes).toString("base64"))
    .join(".");
}
function open(sealed: string) {
  const [ciphertext, iv, authTag] = sealed.split(".").map((part) => Buffer.from(part, "base64"));
  return decrypt({ ciphertext, iv, authTag }, process.env.ENCRYPTION_KEY ?? "");
}
export async function readGrants(workspaceId: string, repositories: InstallationRepository[]) {
  const rows = await getDb().gitHubWorkspaceGrant.findMany({
    where: { workspaceId },
    select: { repoId: true, installationId: true, access: true, revision: true },
  });
  return repositories.map((repo) => {
    const row = rows.find((r) => r.repoId === String(repo.id));
    return {
      id: repo.id,
      name: repo.name,
      access: (row?.installationId === String(repo.installationId)
        ? row.access
        : "none") as AccessLevel,
      revision: row?.revision ?? null,
    };
  });
}

// Serialize issuance and permission edits for a single workspace/repository. Return the
// credential only after commit so a racing downgrade can revoke every delivered token.
export async function repositoryCredential(
  workspaceId: string,
  repo: InstallationRepository,
  change?: { access: AccessLevel; revision: string | null },
): Promise<{ token: string; access: AccessLevel }> {
  const repoKey = String(repo.id);
  return getDb().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + "/" + repoKey}, 0))`;
      const where = { workspaceId_repoId: { workspaceId, repoId: repoKey } };
      const row = await tx.gitHubWorkspaceGrant.findUnique({ where });
      if (change && (row?.revision ?? null) !== change.revision) throw new GrantConflict();
      const existing = row?.installationId === String(repo.installationId) ? row.access : "none";
      const access = change?.access ?? existing;
      if (access !== "read" && access !== "write" && !change) throw new AccessDenied();
      const expiresAt = row?.expiresAt?.getTime() ?? 0;
      const credential = expiresAt > Date.now() ? row?.credential : null;
      if (credential && existing === access && expiresAt > Date.now() + 60000) {
        return { token: open(credential), access: access as AccessLevel };
      }
      // Obtain and verify the replacement before revoking the current token. A failed
      // upgrade must leave the previous credential usable.
      const next =
        access === "read" || access === "write" ? await issueRepositoryToken(repo, access) : null;
      if (credential && next?.token !== open(credential))
        await revokeInstallationToken(open(credential));
      const fields = {
        access,
        installationId: String(repo.installationId),
        revision: change ? randomUUID() : row!.revision,
        credential: next ? seal(next.token) : null,
        expiresAt: next?.expiresAt ?? null,
      };
      await tx.gitHubWorkspaceGrant.upsert({
        where,
        create: { workspaceId, repoId: repoKey, ...fields },
        update: fields,
      });
      return { token: next?.token ?? "", access: access as AccessLevel };
    },
    { timeout: 25000 },
  );
}
