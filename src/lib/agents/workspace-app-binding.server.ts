import type { CoderClient } from "@/lib/coder/client";
import { assertWorkspaceAppIsolated } from "@/lib/security/workspace-app-isolation";
import type { AgentBridgeBinding } from "./portable-contracts";

export type RegistrationPrincipal = { hiveUserId: string; coderUserId: string };
export type VerifiedHostBinding = AgentBridgeBinding & { hiveUserId: string };
export type WorkspaceAppCoder = Pick<
  CoderClient,
  "getWorkspace" | "getWorkspaceResources" | "getApplicationsHost" | "getBaseUrl"
>;
export type VerifiedHostConfig = {
  hiveOrigin: string;
  softwareTemplateIds: string[];
  appSlug: string;
  gatewayPort: number;
  cookieDomains: string[];
};

export class WorkspaceAppSetupError extends Error {
  constructor(readonly reason: "workspace_not_enrolled" | "workspace_bridge_missing") {
    super("Workspace app is not configured for this deployment.");
  }
}

const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("Workspace app authority unavailable or changed.");
}
function origin(value: string) {
  const url = new URL(value);
  requireValue(
    url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.hostname.includes("*"),
  );
  return url;
}

/** Shared fresh Coder authority resolution. No project enrollment or native thread
 * is needed for discovery. Ambiguous matching connected agents fail closed. */
export async function resolveVerifiedWorkspaceHost(
  config: VerifiedHostConfig,
  coderForPrincipal: (principal: RegistrationPrincipal) => Promise<WorkspaceAppCoder>,
  principal: RegistrationPrincipal,
  workspaceId: string,
  agentId?: string,
  expectedBuildId?: string,
): Promise<{ coder: WorkspaceAppCoder; binding: VerifiedHostBinding }> {
  requireValue(
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.appSlug) &&
      config.softwareTemplateIds.length > 0 &&
      config.softwareTemplateIds.every(identifier) &&
      Number.isInteger(config.gatewayPort) &&
      config.gatewayPort > 0 &&
      config.gatewayPort <= 65535,
  );
  origin(config.hiveOrigin);
  requireValue(
    identifier(principal.hiveUserId) &&
      identifier(principal.coderUserId) &&
      identifier(workspaceId) &&
      (agentId === undefined || identifier(agentId)),
  );
  const coder = await coderForPrincipal(principal);
  const coderOrigin = origin(coder.getBaseUrl()).origin;
  const workspace = await coder.getWorkspace(workspaceId);
  requireValue(
    workspace.id === workspaceId &&
      workspace.owner_id === principal.coderUserId &&
      workspace.latest_build.status === "running" &&
      (expectedBuildId === undefined || workspace.latest_build.id === expectedBuildId),
  );
  if (!config.softwareTemplateIds.includes(workspace.template_id))
    throw new WorkspaceAppSetupError("workspace_not_enrolled");

  const resources = await coder.getWorkspaceResources(workspaceId, workspace.latest_build.id);
  const workspaceAgents = resources.flatMap((resource) => resource.agents ?? []);
  const agentApps = (agent: (typeof workspaceAgents)[number]) => {
    // Coder's full WorkspaceAgent response carries apps, which the local SDK omits.
    const apps: unknown = (agent as unknown as { apps?: unknown }).apps;
    return Array.isArray(apps) ? apps : undefined;
  };
  if (
    workspaceAgents.some((agent) => agent.status === "connected") &&
    workspaceAgents.every((agent) => agentApps(agent)?.every((app) => app?.slug !== config.appSlug))
  )
    throw new WorkspaceAppSetupError("workspace_bridge_missing");
  const agents = workspaceAgents.filter((agent) => {
    if (agent.status !== "connected" || (agentId !== undefined && agent.id !== agentId))
      return false;
    return agentApps(agent)?.some(
      (app) =>
        app &&
        app.slug === config.appSlug &&
        app.sharing_level === "owner" &&
        app.subdomain === true &&
        app.external === false,
    );
  });
  requireValue(agents.length === 1);
  const apps = agentApps(agents[0]);
  requireValue(apps);
  const matches = apps.filter(
    (app) =>
      app &&
      app.slug === config.appSlug &&
      app.sharing_level === "owner" &&
      app.subdomain === true &&
      app.external === false,
  );
  requireValue(matches.length === 1);
  requireValue(identifier(matches[0].id) && typeof matches[0].url === "string");
  const appTarget = new URL(matches[0].url);
  requireValue(
    appTarget.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(appTarget.hostname) &&
      Number(appTarget.port) === config.gatewayPort &&
      appTarget.pathname === "/" &&
      !appTarget.search &&
      !appTarget.hash &&
      !appTarget.username &&
      !appTarget.password,
  );
  const parts = [config.appSlug, agents[0].name, workspace.name, workspace.owner_name];
  requireValue(parts.every((part) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(part)));
  const label = parts.join("--");
  requireValue(label.length <= 63);
  const host = await coder.getApplicationsHost();
  requireValue(typeof host === "string" && (host.match(/\*/g) ?? []).length === 1);
  const appUrl = new URL(
    host.includes("://") ? host.replace("*", label) : `https://${host.replace("*", label)}`,
  );
  requireValue(
    appUrl.protocol === "https:" &&
      appUrl.pathname === "/" &&
      !appUrl.search &&
      !appUrl.hash &&
      appUrl.hostname.split(".")[0] === label,
  );
  origin(appUrl.origin);
  assertWorkspaceAppIsolated(
    appUrl.origin,
    origin(config.hiveOrigin).hostname,
    config.cookieDomains,
  );
  const fresh = await coder.getWorkspace(workspaceId);
  requireValue(
    fresh.id === workspace.id &&
      fresh.owner_id === workspace.owner_id &&
      fresh.latest_build.id === workspace.latest_build.id &&
      fresh.latest_build.status === "running" &&
      fresh.template_id === workspace.template_id,
  );
  return {
    coder,
    binding: {
      coderOrigin,
      hiveUserId: principal.hiveUserId,
      ownerId: principal.coderUserId,
      workspaceId,
      buildId: workspace.latest_build.id,
      agentId: agents[0].id,
      templateId: workspace.template_id,
      appOrigin: appUrl.origin,
      appId: matches[0].id,
    },
  };
}
