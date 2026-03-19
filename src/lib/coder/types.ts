/**
 * TypeScript interfaces for the Coder REST API.
 * Covers workspace CRUD and build transitions.
 */

/** Possible workspace build statuses from the Coder API */
export type WorkspaceBuildStatus =
  | "pending"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "deleting"
  | "deleted"
  | "canceling"
  | "canceled"
  | "failed";

/** Workspace object returned by the Coder API */
export interface CoderWorkspace {
  id: string;
  name: string;
  template_id: string;
  owner_name: string;
  latest_build: {
    id: string;
    status: WorkspaceBuildStatus;
    job: {
      status: string;
      error: string;
    };
  };
}

/** Request body for creating a workspace */
export interface CreateWorkspaceRequest {
  name: string;
  template_id: string;
  rich_parameter_values: Array<{ name: string; value: string }>;
  template_version_id?: string;
}

/** Request body for workspace build transitions (start/stop/delete) */
export interface WorkspaceBuildRequest {
  transition: "start" | "stop" | "delete";
}

/** Configuration for the CoderClient */
export interface CoderClientConfig {
  baseUrl: string;
  sessionToken: string;
}

/** Options for the waitForBuild polling method */
export interface WaitForBuildOptions {
  timeoutMs?: number;
  intervalMs?: number;
}
