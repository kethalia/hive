import type {
  ApiKeyInfo,
  BuildInfoResponse,
  CoderClientConfig,
  CoderTemplate,
  CoderTemplateVersion,
  CoderUserResponse,
  CoderWorkspace,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateWorkspaceRequest,
  ListWorkspacesResponse,
  LoginRequest,
  LoginResponse,
  LoginResult,
  ValidateInstanceResult,
  WaitForBuildOptions,
  WorkspaceBuildStatus,
  WorkspaceResource,
} from "./types";

/**
 * Typed REST client for the Coder API.
 *
 * Wraps raw fetch with auth headers, error handling, and a polling utility
 * for workspace build status. No Coder TypeScript SDK exists, so this is
 * the canonical integration point.
 */
export class CoderClient {
  private baseUrl: string;
  private sessionToken: string;

  constructor(config: CoderClientConfig) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.sessionToken = config.sessionToken;
  }

  getSessionToken(): string {
    return this.sessionToken;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Authenticated fetch wrapper. Adds session token header and
   * Content-Type. Throws a descriptive error on non-2xx responses.
   */
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "Coder-Session-Token": this.sessionToken,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });

    if (!res.ok) {
      let body: string;
      try {
        body = await res.text();
      } catch {
        body = "(unable to read response body)";
      }
      throw new Error(`[coder] Request failed: ${res.status} ${res.statusText} — ${body}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Create a new workspace from a template.
   * Transforms a flat Record<string,string> into the rich_parameter_values
   * array format expected by the Coder API.
   */
  async createWorkspace(
    templateId: string,
    name: string,
    params: Record<string, string> = {},
  ): Promise<CoderWorkspace> {
    const body: CreateWorkspaceRequest = {
      name,
      template_id: templateId,
      rich_parameter_values: Object.entries(params).map(([k, v]) => ({
        name: k,
        value: v,
      })),
    };

    console.log(`[coder] Creating workspace "${name}" from template ${templateId}`);

    return this.request<CoderWorkspace>("/api/v2/organizations/default/members/me/workspaces", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Fetch a workspace by ID. */
  async getWorkspace(workspaceId: string): Promise<CoderWorkspace> {
    return this.request<CoderWorkspace>(`/api/v2/workspaces/${workspaceId}`);
  }

  /**
   * List workspaces with optional filters.
   * Maps owner/status to the Coder `q` query-string parameter.
   */
  async listWorkspaces(options?: {
    owner?: string;
    status?: WorkspaceBuildStatus;
  }): Promise<ListWorkspacesResponse> {
    const parts: string[] = [];
    if (options?.owner) parts.push(`owner:${options.owner}`);
    if (options?.status) parts.push(`status:${options.status}`);

    const query = parts.length > 0 ? `?q=${encodeURIComponent(parts.join(" "))}` : "";
    return this.request<ListWorkspacesResponse>(`/api/v2/workspaces${query}`);
  }

  /** Trigger a stop build for a workspace. */
  async stopWorkspace(workspaceId: string): Promise<void> {
    console.log(`[coder] Stopping workspace ${workspaceId}`);
    await this.request(`/api/v2/workspaces/${workspaceId}/builds`, {
      method: "POST",
      body: JSON.stringify({ transition: "stop" }),
    });
  }

  /** Trigger a delete build for a workspace. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    console.log(`[coder] Deleting workspace ${workspaceId}`);
    await this.request(`/api/v2/workspaces/${workspaceId}/builds`, {
      method: "POST",
      body: JSON.stringify({ transition: "delete" }),
    });
  }

  /**
   * Poll getWorkspace until latest_build.status matches `targetStatus`.
   *
   * Uses exponential backoff starting at `intervalMs` (default 1 s),
   * capped at 5 s. Throws immediately if the build reaches 'failed'.
   * Throws on timeout (default 120 s).
   */
  async waitForBuild(
    workspaceId: string,
    targetStatus: string,
    opts?: WaitForBuildOptions,
  ): Promise<CoderWorkspace> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const startInterval = opts?.intervalMs ?? 1_000;
    const maxInterval = 5_000;

    const deadline = Date.now() + timeoutMs;
    let interval = startInterval;

    while (Date.now() < deadline) {
      const ws = await this.getWorkspace(workspaceId);
      const currentStatus = ws.latest_build.status;

      console.log(`[coder] Waiting for workspace ${workspaceId}: ${currentStatus}`);

      if (currentStatus === targetStatus) {
        return ws;
      }

      if (currentStatus === "failed") {
        const errMsg = ws.latest_build.job?.error || "unknown error";
        throw new Error(`[coder] Workspace ${workspaceId} build failed: ${errMsg}`);
      }

      await this.sleep(interval);
      interval = Math.min(interval * 2, maxInterval);
    }

    throw new Error(
      `[coder] Timeout waiting for workspace ${workspaceId} to reach "${targetStatus}" after ${timeoutMs}ms`,
    );
  }

  /**
   * Fetch provisioned resources (and their agents) for a workspace's latest build.
   */
  async getWorkspaceResources(workspaceId: string): Promise<WorkspaceResource[]> {
    const ws = await this.getWorkspace(workspaceId);
    const buildId = ws.latest_build.id;
    return this.request<WorkspaceResource[]>(`/api/v2/workspacebuilds/${buildId}/resources`);
  }

  /**
   * Resolve the SSH-addressable agent name for a workspace.
   * Returns `<workspace_name>.<agent_name>` — the format `coder ssh` expects.
   * Throws if the workspace has no agents.
   */
  async getWorkspaceAgentName(workspaceId: string): Promise<string> {
    const ws = await this.getWorkspace(workspaceId);
    const resources = await this.request<WorkspaceResource[]>(
      `/api/v2/workspacebuilds/${ws.latest_build.id}/resources`,
    );
    for (const resource of resources) {
      if (resource.agents && resource.agents.length > 0) {
        return `${ws.name}.${resource.agents[0].name}`;
      }
    }
    throw new Error(
      `[coder] No agents found for workspace ${workspaceId} — cannot resolve SSH target`,
    );
  }

  // ── Template API ─────────────────────────────────────────────────

  /**
   * List all templates in the default organization.
   * Returns a normalized subset of each template object.
   */
  async listTemplates(): Promise<
    { id: string; name: string; activeVersionId: string; updatedAt: string }[]
  > {
    const templates = await this.request<CoderTemplate[]>(
      "/api/v2/organizations/default/templates",
    );
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      activeVersionId: t.active_version_id,
      updatedAt: t.updated_at,
    }));
  }

  /**
   * Fetch a single template version by ID.
   * Returns id, name, fileId (for tar download), createdAt, and message.
   */
  async getTemplateVersion(
    versionId: string,
  ): Promise<{ id: string; name: string; fileId: string; createdAt: string; message: string }> {
    const version = await this.request<CoderTemplateVersion>(
      `/api/v2/templateversions/${versionId}`,
    );
    return {
      id: version.id,
      name: version.name,
      fileId: version.job.file_id,
      createdAt: version.created_at,
      message: version.message,
    };
  }

  /**
   * Download the template file archive as a Buffer.
   * Returns a tar archive (application/x-tar) of the template files.
   */
  async fetchTemplateFiles(fileId: string): Promise<Buffer> {
    const url = `${this.baseUrl}/api/v2/files/${fileId}`;
    const res = await fetch(url, {
      headers: {
        "Coder-Session-Token": this.sessionToken,
      },
    });

    if (!res.ok) {
      let body: string;
      try {
        body = await res.text();
      } catch {
        body = "(unable to read response body)";
      }
      throw new Error(
        `[coder] fetchTemplateFiles failed: ${res.status} ${res.statusText} — ${body}`,
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ── Static Auth Methods ──────────────────────────────────────────

  static async validateInstance(url: string): Promise<ValidateInstanceResult> {
    const baseUrl = url.replace(/\/+$/, "");
    try {
      const res = await fetch(`${baseUrl}/api/v2/buildinfo`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { valid: false, reason: "not a Coder instance" };
      }
      const data = (await res.json()) as BuildInfoResponse;
      if (!data.version) {
        return { valid: false, reason: "not a Coder instance" };
      }
      return { valid: true, version: data.version };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message.toLowerCase() : String(err);
      if (
        message.includes("getaddrinfo") ||
        message.includes("enotfound") ||
        message.includes("dns")
      ) {
        return { valid: false, reason: "DNS resolution failed" };
      }
      if (
        message.includes("timeout") ||
        message.includes("abort") ||
        message.includes("etimedout")
      ) {
        return { valid: false, reason: "connection timeout" };
      }
      return { valid: false, reason: "not a Coder instance" };
    }
  }

  static async login(baseUrl: string, email: string, password: string): Promise<LoginResult> {
    const url = baseUrl.replace(/\/+$/, "");
    const body: LoginRequest = { email, password };
    const res = await fetch(`${url}/api/v2/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new Error("invalid credentials");
      }
      const text = await res.text().catch(() => "");
      throw new Error(`login failed: ${res.status} ${res.statusText} — ${text}`);
    }

    const loginData = (await res.json()) as LoginResponse;

    const meRes = await fetch(`${url}/api/v2/users/me`, {
      headers: {
        "Content-Type": "application/json",
        "Coder-Session-Token": loginData.session_token,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!meRes.ok) {
      throw new Error("failed to fetch user info after login");
    }

    const user = (await meRes.json()) as CoderUserResponse;

    return {
      sessionToken: loginData.session_token,
      userId: user.id,
      username: user.username,
    };
  }

  static async createApiKey(
    baseUrl: string,
    sessionToken: string,
    userId: string,
    lifetimeSeconds?: number,
  ): Promise<string | null> {
    const url = baseUrl.replace(/\/+$/, "");
    const body: CreateApiKeyRequest = lifetimeSeconds ? { lifetime_seconds: lifetimeSeconds } : {};
    try {
      const res = await fetch(`${url}/api/v2/users/${userId}/keys`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Coder-Session-Token": sessionToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.log(`[coder] API key creation failed: ${res.status} ${res.statusText}`);
        return null;
      }

      const data = (await res.json()) as CreateApiKeyResponse;
      return data.key;
    } catch (err) {
      console.log(
        `[coder] API key creation error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  static async listApiKeys(
    baseUrl: string,
    sessionToken: string,
    userId: string,
  ): Promise<ApiKeyInfo[]> {
    const url = baseUrl.replace(/\/+$/, "");
    try {
      const res = await fetch(`${url}/api/v2/users/${userId}/keys`, {
        headers: {
          "Content-Type": "application/json",
          "Coder-Session-Token": sessionToken,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[coder] listApiKeys failed: ${res.status} ${res.statusText}`);
        return [];
      }

      const data: unknown = await res.json();
      if (!Array.isArray(data)) {
        console.warn("[coder] listApiKeys: unexpected response shape");
        return [];
      }
      return data as ApiKeyInfo[];
    } catch (err) {
      console.warn(
        `[coder] listApiKeys error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  static async deleteApiKey(
    baseUrl: string,
    sessionToken: string,
    userId: string,
    keyId: string,
  ): Promise<boolean> {
    const url = baseUrl.replace(/\/+$/, "");
    try {
      const res = await fetch(`${url}/api/v2/users/${userId}/keys/${keyId}`, {
        method: "DELETE",
        headers: {
          "Coder-Session-Token": sessionToken,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok && res.status !== 204) {
        console.warn(`[coder] deleteApiKey failed: ${res.status} ${res.statusText}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(
        `[coder] deleteApiKey error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // ── Utilities ────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
