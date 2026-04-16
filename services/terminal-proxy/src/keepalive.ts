export class ConnectionRegistry {
  private workspaces = new Map<string, Set<string>>();

  addConnection(workspaceId: string, connectionId: string): void {
    let connections = this.workspaces.get(workspaceId);
    if (!connections) {
      connections = new Set();
      this.workspaces.set(workspaceId, connections);
    }
    connections.add(connectionId);
  }

  removeConnection(workspaceId: string, connectionId: string): void {
    const connections = this.workspaces.get(workspaceId);
    if (!connections) return;
    connections.delete(connectionId);
    if (connections.size === 0) {
      this.workspaces.delete(workspaceId);
    }
  }

  getActiveWorkspaceIds(): string[] {
    return [...this.workspaces.keys()];
  }

  getConnectionCount(workspaceId: string): number {
    return this.workspaces.get(workspaceId)?.size ?? 0;
  }
}

export interface WorkspaceHealth {
  consecutiveFailures: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastError: string | null;
}

const PING_INTERVAL_MS = 55_000;
const FETCH_TIMEOUT_MS = 10_000;
const EXTEND_HOURS = 1;

export class KeepAliveManager {
  private registry: ConnectionRegistry;
  private coderUrl: string;
  private sessionToken: string;
  private healthMap = new Map<string, WorkspaceHealth>();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    registry: ConnectionRegistry,
    coderUrl: string,
    sessionToken: string,
  ) {
    this.registry = registry;
    this.coderUrl = coderUrl.replace(/\/+$/, "");
    this.sessionToken = sessionToken;
  }

  start(): void {
    if (this.intervalId) return;
    console.log("[keep-alive] started");
    void this.pingAll();
    this.intervalId = setInterval(() => void this.pingAll(), PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[keep-alive] stopped");
    }
  }

  getHealth(): Record<string, WorkspaceHealth> {
    const result: Record<string, WorkspaceHealth> = {};
    for (const [id, health] of this.healthMap) {
      result[id] = { ...health };
    }
    return result;
  }

  private async pingAll(): Promise<void> {
    const workspaceIds = this.registry.getActiveWorkspaceIds();

    const activeSet = new Set(workspaceIds);
    for (const id of this.healthMap.keys()) {
      if (!activeSet.has(id)) this.healthMap.delete(id);
    }

    if (workspaceIds.length === 0) return;

    await Promise.allSettled(
      workspaceIds.map((id) => this.ping(id)),
    );
  }

  async ping(workspaceId: string): Promise<void> {
    const deadline = new Date(Date.now() + EXTEND_HOURS * 60 * 60 * 1000).toISOString();
    const url = `${this.coderUrl}/api/v2/workspaces/${workspaceId}/extend`;

    if (!this.healthMap.has(workspaceId)) {
      this.healthMap.set(workspaceId, {
        consecutiveFailures: 0,
        lastSuccess: null,
        lastFailure: null,
        lastError: null,
      });
    }
    const health = this.healthMap.get(workspaceId)!;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Coder-Session-Token": this.sessionToken,
        },
        body: JSON.stringify({ deadline }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const body = await res.text().catch(() => "(unreadable)");
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      health.consecutiveFailures = 0;
      health.lastSuccess = new Date().toISOString();
      console.log(`[keep-alive] ping success workspace=${workspaceId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      health.consecutiveFailures++;
      health.lastFailure = new Date().toISOString();
      health.lastError = message;
      console.error(`[keep-alive] ping failed workspace=${workspaceId} failures=${health.consecutiveFailures} error=${message}`);
    }
  }
}
