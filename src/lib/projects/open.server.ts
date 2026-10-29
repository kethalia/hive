import { getDb } from "@hive/db";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { ProjectDiscoveryError } from "./errors";
import { type ProjectPrincipal, signedHostProjectRequest } from "./host.server";
import {
  enrolledProjectSchema,
  projectOpenRequestSchema,
  resolvedRepositorySchema,
} from "./session-contracts";

/** Repository identity and authorization come from the fixed authenticated helper,
 * never a browser-supplied name, clone URL, local path or cached discovery page. */
export async function openProject(user: ProjectPrincipal, value: unknown) {
  const input = projectOpenRequestSchema.parse(value);
  const target = { repositoryId: input.repositoryId, expectedAccountId: input.providerAccountId };
  const resolved = resolvedRepositorySchema.safeParse(
    await signedHostProjectRequest(user, input.workspaceId, "/projects/resolve", {
      schemaVersion: 1,
      ...target,
    }),
  );
  if (
    !resolved.success ||
    resolved.data.providerAccountId !== input.providerAccountId ||
    resolved.data.repository.providerRepositoryId !== input.repositoryId
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  if (resolved.data.repository.permissions.pull !== true)
    throw new ProjectDiscoveryError("github_permission_denied");
  const project = await new DeliveryRepository(getDb()).bindProject(user.id, {
    provider: "github",
    providerRepositoryId: input.repositoryId,
    providerAccountId: resolved.data.providerAccountId,
    fullName: resolved.data.repository.fullName,
  });
  const opened = enrolledProjectSchema.safeParse(
    await signedHostProjectRequest(user, input.workspaceId, "/projects/open", {
      schemaVersion: 1,
      ...target,
      projectId: project.id,
      requestId: input.requestId,
    }),
  );
  if (
    !opened.success ||
    opened.data.projectId !== project.id ||
    opened.data.providerAccountId !== input.providerAccountId ||
    opened.data.repository.providerRepositoryId !== input.repositoryId
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  if (opened.data.repository.permissions.pull !== true)
    throw new ProjectDiscoveryError("github_permission_denied");
  // Resolve and enrollment independently validate access. Names may change between
  // them; record only the most recently verified name, preserving the stable ID.
  if (opened.data.repository.fullName !== project.fullName)
    await new DeliveryRepository(getDb()).bindProject(user.id, {
      provider: "github",
      providerRepositoryId: input.repositoryId,
      providerAccountId: input.providerAccountId,
      fullName: opened.data.repository.fullName,
    });
  return { ...opened.data, workspaceId: input.workspaceId };
}
