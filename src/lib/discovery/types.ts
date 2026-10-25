import type { AgentToolsSnapshot } from "@/lib/agents/types";
import type { CoderWorkspace, WorkspaceAgentStatus } from "@/lib/coder/types";
import type { PublicCloneTree } from "@/lib/git/clone-actions-contract";
import type { TemplateStatus } from "@/lib/templates/staleness";
import type { TmuxSession } from "@/lib/workspaces/sessions";

export interface DiscoveryData {
  workspaces: CoderWorkspace[];
  agent: {
    agentId: string;
    agentName: string;
    agentStatus: WorkspaceAgentStatus;
    templateName: string;
  };
  sessions: TmuxSession[];
  repositories: PublicCloneTree;
  "agent-tools": AgentToolsSnapshot;
  templates: TemplateStatus[];
  "template-options": { id: string; name: string; activeVersionId: string; updatedAt: string }[];
}
export type DiscoveryResource = keyof DiscoveryData;
export interface DiscoveryTarget {
  workspaceId?: string;
  buildId?: string;
}
export const discoveryFreshness: Record<DiscoveryResource, number> = {
  workspaces: 5_000,
  agent: 5_000,
  sessions: 5_000,
  repositories: 60_000,
  "agent-tools": 5_000,
  templates: 300_000,
  "template-options": 60_000,
};
export class DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly cachedDataDenied = [401, 403, 404, 409].includes(status),
  ) {
    super(message);
  }
}

export function isDiscoveryDenied(error: unknown): boolean {
  return error instanceof DiscoveryError && error.cachedDataDenied;
}
