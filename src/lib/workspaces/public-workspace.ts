import type { CoderWorkspace } from "@/lib/coder/types";

/** Browser workspace summary. Provider responses can contain undeclared agent
 * credentials and commands; select every public field, including nested objects. */
export function toPublicWorkspace(workspace: CoderWorkspace): CoderWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    template_id: workspace.template_id,
    owner_name: workspace.owner_name,
    owner_id: workspace.owner_id,
    template_name: workspace.template_name,
    template_display_name: workspace.template_display_name,
    template_icon: workspace.template_icon,
    last_used_at: workspace.last_used_at,
    health: workspace.health
      ? {
          healthy: workspace.health.healthy,
          failing_agents: [...workspace.health.failing_agents],
        }
      : undefined,
    latest_build: {
      template_version_id: workspace.latest_build.template_version_id,
      id: workspace.latest_build.id,
      status: workspace.latest_build.status,
      job: {
        status: workspace.latest_build.job.status,
        error: workspace.latest_build.job.error,
      },
    },
  };
}
