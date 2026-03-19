import type {
  CoderClientConfig,
  CoderWorkspace,
  CreateWorkspaceRequest,
  WaitForBuildOptions,
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

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Authenticated fetch wrapper. Adds session token header and
   * Content-Type. Throws a descriptive error on non-2xx responses.
   */
  private async request<T>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
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
      throw new Error(
        `[coder] Request failed: ${res.status} ${res.statusText} — ${body}`
      );
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
    params: Record<string, string> = {}
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

    return this.request<CoderWorkspace>(
      "/api/v2/organizations/default/members/me/workspaces",
      { method: "POST", body: JSON.stringify(body) }
    );
  }

  /** Fetch a workspace by ID. */
  async getWorkspace(workspaceId: string): Promise<CoderWorkspace> {
    return this.request<CoderWorkspace>(
      `/api/v2/workspaces/${workspaceId}`
    );
  }

  /** Trigger a stop build for a workspace. */
  async stopWorkspace(workspaceId: string): Promise<void> {
    console.log(`[coder] Stopping workspace ${workspaceId}`);
    await this.request(
      `/api/v2/workspaces/${workspaceId}/builds`,
      { method: "POST", body: JSON.stringify({ transition: "stop" }) }
    );
  }

  /** Trigger a delete build for a workspace. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    console.log(`[coder] Deleting workspace ${workspaceId}`);
    await this.request(
      `/api/v2/workspaces/${workspaceId}/builds`,
      { method: "POST", body: JSON.stringify({ transition: "delete" }) }
    );
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
    opts?: WaitForBuildOptions
  ): Promise<CoderWorkspace> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const startInterval = opts?.intervalMs ?? 1_000;
    const maxInterval = 5_000;

    const deadline = Date.now() + timeoutMs;
    let interval = startInterval;

    while (Date.now() < deadline) {
      const ws = await this.getWorkspace(workspaceId);
      const currentStatus = ws.latest_build.status;

      console.log(
        `[coder] Waiting for workspace ${workspaceId}: ${currentStatus}`
      );

      if (currentStatus === targetStatus) {
        return ws;
      }

      if (currentStatus === "failed") {
        const errMsg = ws.latest_build.job?.error || "unknown error";
        throw new Error(
          `[coder] Workspace ${workspaceId} build failed: ${errMsg}`
        );
      }

      await this.sleep(interval);
      interval = Math.min(interval * 2, maxInterval);
    }

    throw new Error(
      `[coder] Timeout waiting for workspace ${workspaceId} to reach "${targetStatus}" after ${timeoutMs}ms`
    );
  }

  // ── Utilities ────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
