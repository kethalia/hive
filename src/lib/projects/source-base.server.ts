import { repositoryPolicyCatalogSchema } from "@/lib/delivery/repository-policy-contracts";
import { DeliveryConflict } from "@/lib/delivery/state";
import { ProjectDiscoveryError } from "./errors";
import { type ProjectPrincipal, signedHostProjectRequest } from "./host.server";
import { type ResolvedRepository, resolvedRepositoryRefSchema } from "./session-contracts";

/** The deployment catalog chooses the base; browser/model requests never choose refs. */
export async function resolveProjectSourceBase(
  user: ProjectPrincipal,
  workspaceId: string,
  resolved: ResolvedRepository,
) {
  const fallback = {
    branch: resolved.repository.defaultBranch,
    revision: resolved.defaultRevision,
  };
  if (process.env.HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED !== "true") return fallback;
  const raw = process.env.HIVE_DELIVERY_REPOSITORY_POLICIES_JSON;
  if (!raw || Buffer.byteLength(raw) > 262144)
    throw new DeliveryConflict("repository_policy_catalog_unavailable");
  let catalog: ReturnType<typeof repositoryPolicyCatalogSchema.parse>;
  try {
    catalog = repositoryPolicyCatalogSchema.parse(JSON.parse(raw));
  } catch {
    throw new DeliveryConflict("repository_policy_catalog_unavailable");
  }
  const entry = catalog.find(
    (item) =>
      item.ownerId === user.id && item.repositoryId === resolved.repository.providerRepositoryId,
  );
  if (
    !entry ||
    entry.providerAccountId !== resolved.providerAccountId ||
    entry.fullName !== resolved.repository.fullName
  )
    throw new DeliveryConflict("repository_policy_not_enrolled");
  // Resolve even the default branch through exact refs/heads. /commits/{name}
  // accepts tags and expressions, which must never select a policy base.
  const branch = entry.policy.source.baseBranch;
  const result = resolvedRepositoryRefSchema.safeParse(
    await signedHostProjectRequest(user, workspaceId, "/projects/resolve-ref", {
      schemaVersion: 1,
      repositoryId: entry.repositoryId,
      expectedAccountId: entry.providerAccountId,
      branch,
    }),
  );
  if (
    !result.success ||
    result.data.providerAccountId !== entry.providerAccountId ||
    result.data.repository.providerRepositoryId !== entry.repositoryId ||
    result.data.repository.fullName !== entry.fullName ||
    result.data.branch !== branch
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  if (
    result.data.repository.archived ||
    result.data.repository.permissions.pull !== true ||
    result.data.repository.permissions.push !== true
  )
    throw new ProjectDiscoveryError("github_permission_denied");
  return { branch, revision: result.data.revision };
}
