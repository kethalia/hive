import { projectPageSchema } from "./contracts";
import { ProjectDiscoveryError } from "./errors";
import { readGrants, repositoryCredential } from "./grants.server";
import { installationRepository, type workspaceBinding } from "./installation.server";
import { ownsGrantWorkspace } from "./permission-owner.server";

export async function discoverScoped(
  user: { id: string; coderUserId: string },
  workspaceId: string,
  binding: NonNullable<ReturnType<typeof workspaceBinding>>,
  page: number,
  perPage: number,
  signal?: AbortSignal,
) {
  if (!(await ownsGrantWorkspace(workspaceId, binding, user, signal)))
    throw new ProjectDiscoveryError("workspace_forbidden");
  const grants = (await readGrants(workspaceId, binding.repositories)).filter(
    (grant) => grant.access !== "none",
  );
  const slice = grants.slice((page - 1) * perPage, page * perPage);
  const repositories = [];
  // Keep outbound GitHub requests within the Worker's connection limit.
  for (const grant of slice) {
    const repo = binding.repositories.find((repo) => repo.id === grant.id)!;
    const { token, access } = await repositoryCredential(workspaceId, repo);
    const data = await installationRepository(repo, token);
    repositories.push({
      provider: "github",
      providerRepositoryId: String(repo.id),
      nodeId: data.node_id,
      fullName: data.full_name,
      name: data.name,
      owner: data.owner.login,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
      private: data.private,
      archived: data.archived,
      permissions: { pull: true, push: access === "write", admin: false },
    });
  }
  return projectPageSchema.parse({
    schemaVersion: 1,
    provider: "github",
    providerAccountId: process.env.HIVE_GITHUB_APP_ID,
    repositories,
    page,
    perPage,
    nextPage: page * perPage < grants.length ? page + 1 : null,
  });
}
