import { projectRequestSchema } from "./contracts";
import { ProjectDiscoveryError } from "./errors";

export { ProjectDiscoveryError };

export async function discoverWorkspaceProjects(
  user: { id: string; coderUserId: string },
  value: unknown,
) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true")
    throw new ProjectDiscoveryError("discovery_disabled");
  const request = projectRequestSchema.parse(value);
  if (process.env.HIVE_CODEX_GATEWAY_ENABLED === "true") {
    const { discoverHostProjects } = await import("./host.server");
    return discoverHostProjects(user, request);
  }
  // Workers must never fall back to shell execution or a Kubernetes Hive origin.
  if (process.env.HIVE_RUNTIME_TARGET === "cloudflare")
    throw new ProjectDiscoveryError("discovery_unavailable");
  const { discoverWorkspaceProjects: legacy } = await import("./workspace.node");
  return legacy(user, request);
}
