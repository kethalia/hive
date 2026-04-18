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
  template_name?: string;
  template_display_name?: string;
  template_icon?: string;
  last_used_at?: string;
  health?: { healthy: boolean; failing_agents: string[] };
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

/** Coder agent lifecycle statuses */
export type WorkspaceAgentStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "timeout"
  | "lifecycle_ready"
  | "starting"
  | "start_error"
  | "shutting_down"
  | "shutdown_error"
  | "off";

/** An agent running inside a workspace resource (from build resources endpoint). */
export interface WorkspaceAgent {
  id: string;
  name: string;
  status: WorkspaceAgentStatus;
}

/** A resource provisioned by a workspace build (compute, volume, etc.). */
export interface WorkspaceResource {
  id: string;
  name: string;
  type: string;
  agents?: WorkspaceAgent[];
}

/** Response shape from GET /api/v2/workspaces */
export interface ListWorkspacesResponse {
  workspaces: CoderWorkspace[];
  count: number;
}

/** A Coder template summary (from GET /api/v2/organizations/default/templates). */
export interface CoderTemplate {
  id: string;
  name: string;
  active_version_id: string;
  updated_at: string;
}

/** A Coder template version (from GET /api/v2/templateversions/:id). */
export interface CoderTemplateVersion {
  id: string;
  name: string;
  message: string;
  job: {
    file_id: string;
  };
  created_at: string;
}

/** Response from GET /api/v2/buildinfo */
export interface BuildInfoResponse {
  version: string;
  external_url: string;
}

/** Request body for POST /api/v2/users/login */
export interface LoginRequest {
  email: string;
  password: string;
}

/** Response from POST /api/v2/users/login */
export interface LoginResponse {
  session_token: string;
}

/** Request body for POST /api/v2/users/{id}/keys */
export interface CreateApiKeyRequest {
  lifetime_seconds?: number;
}

/** Response from POST /api/v2/users/{id}/keys */
export interface CreateApiKeyResponse {
  key: string;
}

/** Result of validateInstance */
export interface ValidateInstanceResult {
  valid: boolean;
  version?: string;
  reason?: string;
}

/** Result of login */
export interface LoginResult {
  sessionToken: string;
  userId: string;
  username: string;
}

/** User info from /api/v2/users/me */
export interface CoderUserResponse {
  id: string;
  username: string;
  email: string;
}
