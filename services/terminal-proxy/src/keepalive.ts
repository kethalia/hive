export interface ConnectionMeta {
  token: string;
  coderUrl: string;
}

export type KeepAliveFailureCategory =
  | "manual-shutdown"
  | "http-auth"
  | "http-client"
  | "http-server"
  | "timeout"
  | "network"
  | "unknown";

export type KeepAliveFailureReason =
  | "manual-shutdown"
  | "coder-auth-rejected"
  | "workspace-not-found"
  | "coder-client-error"
  | "coder-server-error"
  | "coder-timeout"
  | "network-error"
  | "unknown-error";

export type KeepAliveStatus =
  | "healthy"
  | "failing"
  | "not-applicable"
  | "no-token"
  | "recently-disconnected";

export interface WorkspaceHealth {
  status: KeepAliveStatus;
  consecutiveFailures: number;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastFailureCategory: KeepAliveFailureCategory | null;
  lastFailureReason: KeepAliveFailureReason | null;
  lastFailureDetail: string | null;
  lastHttpStatus: number | null;
  lastHttpStatusText: string | null;
  lastAttemptDurationMs: number | null;
  activeConnectionCount: number;
  lastDisconnectedAt: string | null;
}

export interface SerializedWorkspaceHealth {
  consecutiveFailures: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  status: KeepAliveStatus;
  lastAttempt: string | null;
  lastFailureCategory: KeepAliveFailureCategory | null;
  lastFailureReason: KeepAliveFailureReason | null;
  lastFailureDetail: string | null;
  lastHttpStatus: number | null;
  lastHttpStatusText: string | null;
  lastAttemptDurationMs: number | null;
  activeConnectionCount: number;
  lastDisconnectedAt: string | null;
}

export interface KeepAliveStatusPayload {
  workspaces: Record<string, SerializedWorkspaceHealth>;
}

export function serializeKeepAliveStatusPayload(
  health: Record<string, WorkspaceHealth> | null | undefined,
): KeepAliveStatusPayload {
  const workspaces: Record<string, SerializedWorkspaceHealth> = {};

  for (const [id, workspaceHealth] of Object.entries(health ?? {})) {
    workspaces[id] = {
      consecutiveFailures: workspaceHealth.consecutiveFailures,
      lastSuccess: workspaceHealth.lastSuccess,
      lastFailure: workspaceHealth.lastFailure,
      status: workspaceHealth.status,
      lastAttempt: workspaceHealth.lastAttempt,
      lastFailureCategory: workspaceHealth.lastFailureCategory,
      lastFailureReason: workspaceHealth.lastFailureReason,
      lastFailureDetail: workspaceHealth.lastFailureDetail,
      lastHttpStatus: workspaceHealth.lastHttpStatus,
      lastHttpStatusText: workspaceHealth.lastHttpStatusText,
      lastAttemptDurationMs: workspaceHealth.lastAttemptDurationMs,
      activeConnectionCount: workspaceHealth.activeConnectionCount,
      lastDisconnectedAt: workspaceHealth.lastDisconnectedAt,
    };
  }

  return { workspaces };
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
    lastFailureReason: null,
    lastFailureDetail: null,
    lastHttpStatus: null,
    lastHttpStatusText: null,
    lastAttemptDurationMs: null,
    activeConnectionCount,
    lastDisconnectedAt: null,
  };
}

interface KeepAliveFailureDetails {
  category: KeepAliveFailureCategory;
  reason: KeepAliveFailureReason;
  detail: string;
  httpStatus: number | null;
  httpStatusText: string | null;
}

const MAX_DIAGNOSTIC_DETAIL_LENGTH = 240;

function boundedDiagnosticDetail(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_DIAGNOSTIC_DETAIL_LENGTH
    ? `${normalized.slice(0, MAX_DIAGNOSTIC_DETAIL_LENGTH - 1)}…`
    : normalized;
}

function extractCoderMessage(body: string): string | null {
  if (!body.trim()) return null;

  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.message === "string") return record.message;
      if (typeof record.detail === "string") return record.detail;
      if (typeof record.error === "string") return record.error;
    }
  } catch {
    // Fall back to sanitized body text below.
  }

  return body;
}

function sanitizeDiagnosticDetail(value: string): string {
  return boundedDiagnosticDetail(value)
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b[\w-]*(?:token|secret|proof|password|credential|session)[\w-]*\b/gi, "<redacted>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<redacted>")
    .replace(/\bws-[A-Za-z0-9_-]+\b/g, "<workspace>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<uuid>",
    )
    .replace(/(?:^|\s)\/[\w./-]+/g, " <path>")
    .trim();
}

function safeStatusText(statusText: string): string | null {
  const sanitized = sanitizeDiagnosticDetail(statusText);
  return sanitized.length > 0 ? sanitized : null;
}

function httpFailureDetails(
  status: number,
  statusText: string,
  body: string,
): KeepAliveFailureDetails {
  const coderMessage = extractCoderMessage(body);
  const sanitizedMessage = coderMessage ? sanitizeDiagnosticDetail(coderMessage) : null;
  const httpStatusText = safeStatusText(statusText);
  const statusLabel = httpStatusText ? `HTTP ${status} ${httpStatusText}` : `HTTP ${status}`;

  if (
    status === 409 &&
    sanitizedMessage &&
    /workspace shutdown is manual/i.test(sanitizedMessage)
  ) {
    return {
      category: "manual-shutdown",
      reason: "manual-shutdown",
      detail: "Coder reports workspace shutdown is manual; keepalive extension is not applicable.",
      httpStatus: status,
      httpStatusText,
    };
  }

  if (status === 401 || status === 403) {
    return {
      category: "http-auth",
      reason: "coder-auth-rejected",
      detail: sanitizedMessage || `${statusLabel}: Coder rejected the keepalive token.`,
      httpStatus: status,
      httpStatusText,
    };
  }

  if (status === 404) {
    return {
      category: "http-client",
      reason: "workspace-not-found",
      detail:
        sanitizedMessage ||
        `${statusLabel}: Coder could not find this workspace for the active token.`,
      httpStatus: status,
      httpStatusText,
    };
  }

  if (status >= 400 && status < 500) {
    return {
      category: "http-client",
      reason: "coder-client-error",
      detail: sanitizedMessage || `${statusLabel}: Coder rejected the keepalive request.`,
      httpStatus: status,
      httpStatusText,
    };
  }

  if (status >= 500 && status < 600) {
    return {
      category: "http-server",
      reason: "coder-server-error",
      detail: sanitizedMessage || `${statusLabel}: Coder failed while extending the workspace.`,
      httpStatus: status,
      httpStatusText,
    };
  }

  return {
    category: "unknown",
    reason: "unknown-error",
    detail: sanitizedMessage || `${statusLabel}: Coder returned an unexpected keepalive response.`,
    httpStatus: status,
    httpStatusText,
  };
}

function thrownFailureDetails(err: unknown): KeepAliveFailureDetails {
  if (err instanceof DOMException && err.name === "AbortError") {
    return {
      category: "timeout",
      reason: "coder-timeout",
      detail: `Keepalive request timed out after ${FETCH_TIMEOUT_MS}ms.`,
      httpStatus: null,
      httpStatusText: null,
    };
  }

  if (err instanceof Error && err.name === "AbortError") {
    return {
      category: "timeout",
      reason: "coder-timeout",
      detail: `Keepalive request timed out after ${FETCH_TIMEOUT_MS}ms.`,
      httpStatus: null,
      httpStatusText: null,
    };
  }

  if (err instanceof Error) {
    return {
      category: "network",
      reason: "network-error",
      detail: sanitizeDiagnosticDetail(err.message) || "Network error while contacting Coder API.",
      httpStatus: null,
      httpStatusText: null,
    };
  }

  return {
    category: "unknown",
    reason: "unknown-error",
    detail: "Unknown error while contacting Coder API.",
    httpStatus: null,
    httpStatusText: null,
  };
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
    health.lastAttemptDurationMs = null;
    health.lastDisconnectedAt = null;

    const attemptStartedAt = Date.now();
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
        const body = await res.text().catch(() => "");
        this.recordFailure(
          health,
          httpFailureDetails(res.status, res.statusText ?? "", body),
          activeConnectionCount,
          attemptStartedAt,
        );
        return;
      }

      health.status = "healthy";
      health.consecutiveFailures = 0;
      health.lastSuccess = new Date().toISOString();
      health.lastFailureCategory = null;
      health.lastFailureReason = null;
      health.lastFailureDetail = null;
      health.lastHttpStatus = null;
      health.lastHttpStatusText = null;
      health.lastAttemptDurationMs = Date.now() - attemptStartedAt;
      console.log(
        `[keep-alive] event=ping-success status=healthy activeConnectionCount=${activeConnectionCount} attemptDurationMs=${health.lastAttemptDurationMs}`,
      );
    } catch (err: unknown) {
      this.recordFailure(
        health,
        thrownFailureDetails(err),
        activeConnectionCount,
        attemptStartedAt,
      );
    }
  }

  private recordFailure(
    health: WorkspaceHealth,
    failure: KeepAliveFailureDetails,
    activeConnectionCount: number,
    attemptStartedAt: number,
  ): void {
    health.status = failure.category === "manual-shutdown" ? "not-applicable" : "failing";
    health.consecutiveFailures =
      failure.category === "manual-shutdown" ? 0 : health.consecutiveFailures + 1;
    health.lastFailure = new Date().toISOString();
    health.lastFailureCategory = failure.category;
    health.lastFailureReason = failure.reason;
    health.lastFailureDetail = failure.detail;
    health.lastHttpStatus = failure.httpStatus;
    health.lastHttpStatusText = failure.httpStatusText;
    health.lastAttemptDurationMs = Date.now() - attemptStartedAt;
    console.error(
      `[keep-alive] event=ping-failed status=${health.status} failureCategory=${failure.category} failureReason=${failure.reason} httpStatus=${failure.httpStatus ?? "none"} consecutiveFailures=${health.consecutiveFailures} activeConnectionCount=${activeConnectionCount} attemptDurationMs=${health.lastAttemptDurationMs}`,
    );
  }
}
