export interface ConnectionMeta {
  token: string;
  coderUrl: string;
}

export type KeepAliveFailureCategory =
  | "http-auth"
  | "http-client"
  | "http-server"
  | "timeout"
  | "network"
  | "unknown";

export type KeepAliveStatus = "healthy" | "failing" | "no-token" | "recently-disconnected";

export interface WorkspaceHealth {
  status: KeepAliveStatus;
  consecutiveFailures: number;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastFailureCategory: KeepAliveFailureCategory | null;
  activeConnectionCount: number;
  lastDisconnectedAt: string | null;
}

interface RecentlyDisconnectedWorkspace {
  disconnectedAt: string;
  expiresAt: number;
}

const PING_INTERVAL_MS = 55_000;
const FETCH_TIMEOUT_MS = 10_000;
const EXTEND_HOURS = 1;
const RECENTLY_DISCONNECTED_TTL_MS = 5 * 60_000;
const MAX_RECENTLY_DISCONNECTED = 100;

export class ConnectionRegistry {
  private workspaces = new Map<string, Set<string>>();
  private connectionMeta = new Map<string, ConnectionMeta>();
  private recentlyDisconnected = new Map<string, RecentlyDisconnectedWorkspace>();

  addConnection(workspaceId: string, connectionId: string, meta?: ConnectionMeta): void {
    this.recentlyDisconnected.delete(workspaceId);

    let connections = this.workspaces.get(workspaceId);
    if (!connections) {
      connections = new Set();
      this.workspaces.set(workspaceId, connections);
    }
    connections.add(connectionId);
    if (meta) {
      this.connectionMeta.set(connectionId, meta);
    }
  }

  removeConnection(workspaceId: string, connectionId: string): void {
    const connections = this.workspaces.get(workspaceId);
    if (!connections) return;
    connections.delete(connectionId);
    this.connectionMeta.delete(connectionId);
    if (connections.size === 0) {
      this.workspaces.delete(workspaceId);
      const now = Date.now();
      this.recentlyDisconnected.set(workspaceId, {
        disconnectedAt: new Date(now).toISOString(),
        expiresAt: now + RECENTLY_DISCONNECTED_TTL_MS,
      });
      this.pruneRecentlyDisconnected(now);
    }
  }

  getActiveWorkspaceIds(): string[] {
    return [...this.workspaces.keys()];
  }

  getRecentlyDisconnectedWorkspaces(): Record<string, { disconnectedAt: string }> {
    this.pruneRecentlyDisconnected(Date.now());
    const result: Record<string, { disconnectedAt: string }> = {};
    for (const [workspaceId, record] of this.recentlyDisconnected) {
      result[workspaceId] = { disconnectedAt: record.disconnectedAt };
    }
    return result;
  }

  getConnectionCount(workspaceId: string): number {
    return this.workspaces.get(workspaceId)?.size ?? 0;
  }

  getWorkspaceMeta(workspaceId: string): ConnectionMeta | null {
    const connections = this.workspaces.get(workspaceId);
    if (!connections) return null;
    for (const connId of connections) {
      const meta = this.connectionMeta.get(connId);
      if (meta) return meta;
    }
    return null;
  }

  private pruneRecentlyDisconnected(now: number): void {
    for (const [workspaceId, record] of this.recentlyDisconnected) {
      if (record.expiresAt <= now || this.workspaces.has(workspaceId)) {
        this.recentlyDisconnected.delete(workspaceId);
      }
    }

    while (this.recentlyDisconnected.size > MAX_RECENTLY_DISCONNECTED) {
      const oldestWorkspaceId = this.recentlyDisconnected.keys().next().value;
      if (!oldestWorkspaceId) break;
      this.recentlyDisconnected.delete(oldestWorkspaceId);
    }
  }
}

function emptyHealth(activeConnectionCount: number): WorkspaceHealth {
  return {
    status: "healthy",
    consecutiveFailures: 0,
    lastAttempt: null,
    lastSuccess: null,
    lastFailure: null,
    lastFailureCategory: null,
    activeConnectionCount,
    lastDisconnectedAt: null,
  };
}

function classifyHttpStatus(status: number): KeepAliveFailureCategory {
  if (status === 401 || status === 403) return "http-auth";
  if (status >= 400 && status < 500) return "http-client";
  if (status >= 500 && status < 600) return "http-server";
  return "unknown";
}

function classifyThrownError(err: unknown): KeepAliveFailureCategory {
  if (err instanceof DOMException && err.name === "AbortError") return "timeout";
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  if (err instanceof Error) return "network";
  return "unknown";
}

export class KeepAliveManager {
  private registry: ConnectionRegistry;
  private defaultCoderUrl: string;
  private healthMap = new Map<string, WorkspaceHealth>();
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(registry: ConnectionRegistry, defaultCoderUrl: string) {
    this.registry = registry;
    this.defaultCoderUrl = defaultCoderUrl.replace(/\/+$/, "");
  }

  start(): void {
    if (this.intervalId) return;
    console.log("[keep-alive] event=started");
    void this.pingAll();
    this.intervalId = setInterval(() => void this.pingAll(), PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[keep-alive] event=stopped");
    }
  }

  getHealth(): Record<string, WorkspaceHealth> {
    const activeWorkspaceIds = new Set(this.registry.getActiveWorkspaceIds());
    const recentWorkspaces = this.registry.getRecentlyDisconnectedWorkspaces();
    const recentWorkspaceIds = new Set(Object.keys(recentWorkspaces));
    const result: Record<string, WorkspaceHealth> = {};

    for (const [id, health] of this.healthMap) {
      if (activeWorkspaceIds.has(id)) {
        result[id] = {
          ...health,
          activeConnectionCount: this.registry.getConnectionCount(id),
          lastDisconnectedAt: null,
        };
      } else if (recentWorkspaceIds.has(id)) {
        result[id] = {
          ...health,
          status: "recently-disconnected",
          activeConnectionCount: 0,
          lastDisconnectedAt: recentWorkspaces[id].disconnectedAt,
        };
      }
    }

    for (const [id, recent] of Object.entries(recentWorkspaces)) {
      if (!result[id]) {
        result[id] = {
          ...emptyHealth(0),
          status: "recently-disconnected",
          lastDisconnectedAt: recent.disconnectedAt,
        };
      }
    }

    return result;
  }

  private async pingAll(): Promise<void> {
    const workspaceIds = this.registry.getActiveWorkspaceIds();

    const activeSet = new Set(workspaceIds);
    const recentSet = new Set(Object.keys(this.registry.getRecentlyDisconnectedWorkspaces()));
    for (const id of this.healthMap.keys()) {
      if (!activeSet.has(id) && !recentSet.has(id)) this.healthMap.delete(id);
    }

    if (workspaceIds.length === 0) return;

    await Promise.allSettled(workspaceIds.map((id) => this.ping(id)));
  }

  async ping(workspaceId: string): Promise<void> {
    const activeConnectionCount = this.registry.getConnectionCount(workspaceId);
    let health = this.healthMap.get(workspaceId);
    if (!health) {
      health = emptyHealth(activeConnectionCount);
      this.healthMap.set(workspaceId, health);
    }

    health.activeConnectionCount = activeConnectionCount;
    health.lastAttempt = new Date().toISOString();
    health.lastDisconnectedAt = null;

    const meta = this.registry.getWorkspaceMeta(workspaceId);
    if (!meta) {
      health.status = "no-token";
      console.log(
        `[keep-alive] event=ping-skipped status=no-token activeConnectionCount=${activeConnectionCount}`,
      );
      return;
    }

    const coderUrl = (meta.coderUrl || this.defaultCoderUrl).replace(/\/+$/, "");
    const deadline = new Date(Date.now() + EXTEND_HOURS * 60 * 60 * 1000).toISOString();
    const url = `${coderUrl}/api/v2/workspaces/${workspaceId}/extend`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Coder-Session-Token": meta.token,
          },
          body: JSON.stringify({ deadline }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        this.recordFailure(health, classifyHttpStatus(res.status), activeConnectionCount);
        return;
      }

      health.status = "healthy";
      health.consecutiveFailures = 0;
      health.lastSuccess = new Date().toISOString();
      health.lastFailureCategory = null;
      console.log(
        `[keep-alive] event=ping-success status=healthy activeConnectionCount=${activeConnectionCount}`,
      );
    } catch (err: unknown) {
      this.recordFailure(health, classifyThrownError(err), activeConnectionCount);
    }
  }

  private recordFailure(
    health: WorkspaceHealth,
    failureCategory: KeepAliveFailureCategory,
    activeConnectionCount: number,
  ): void {
    health.status = "failing";
    health.consecutiveFailures++;
    health.lastFailure = new Date().toISOString();
    health.lastFailureCategory = failureCategory;
    console.error(
      `[keep-alive] event=ping-failed status=failing failureCategory=${failureCategory} consecutiveFailures=${health.consecutiveFailures} activeConnectionCount=${activeConnectionCount}`,
    );
  }
}
