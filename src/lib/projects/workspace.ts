import { AgentBridgeError } from "@/lib/agents/portable-client.server";
import { createProjectDiscoveryService } from "@/lib/agents/portable-config.server";
import { projectRequestSchema } from "./contracts";
import { ProjectDiscoveryError } from "./errors";
import { workspaceBinding } from "./installation.server";
import { discoverScoped } from "./scoped-discovery.server";

export { ProjectDiscoveryError };

export async function discoverWorkspaceProjects(
  user: { id: string; coderUserId: string },
  value: unknown,
  signal?: AbortSignal,
) {
  const { workspaceId, page, perPage } = projectRequestSchema.parse(value);
  try {
    const binding = workspaceBinding(workspaceId);
    if (binding) return await discoverScoped(user, workspaceId, binding, page, perPage, signal);
    const result = await createProjectDiscoveryService().execute<"discover-projects">(
      { hiveUserId: user.id, coderUserId: user.coderUserId },
      workspaceId,
      { operation: "discover-projects", page, perPage },
      signal,
    );
    if ("error" in result) throw new ProjectDiscoveryError(result.error);
    if (result.page !== page || result.perPage !== perPage)
      throw new ProjectDiscoveryError("github_invalid_response");
    return result;
  } catch (error) {
    if (error instanceof AgentBridgeError)
      throw new ProjectDiscoveryError(
        error.code === "unsupported" ? "unsupported_schema" : "workspace_unavailable",
      );
    throw error;
  }
}
