import { randomUUID } from "node:crypto";

export const TERMINAL_SESSION_EVENT_PAYLOAD_VERSION = 1;

export type TerminalSessionKind = "git" | "terminal";
export type TerminalSessionEventLevel = "error" | "info" | "warning";
export type TerminalSessionEventType =
  | "browser_disconnected"
  | "browser_error"
  | "browser_input"
  | "connection_accepted"
  | "heartbeat"
  | "heartbeat_timeout"
  | "upstream_closed"
  | "upstream_connect_timeout"
  | "upstream_connected"
  | "upstream_connecting"
  | "upstream_error"
  | "upstream_output";

export type TerminalSessionEventDetails = Record<string, boolean | number | string | null>;

export interface TerminalSessionEvent {
  id: number;
  timestamp: string;
  workspaceId: string;
  connectionId: string;
  sessionName: string;
  sessionKind: TerminalSessionKind;
  level: TerminalSessionEventLevel;
  type: TerminalSessionEventType;
  details: TerminalSessionEventDetails;
}

export interface RecordTerminalSessionEventInput {
  workspaceId: string;
  connectionId: string;
  sessionName: string;
  sessionKind: TerminalSessionKind;
  level?: TerminalSessionEventLevel;
  type: TerminalSessionEventType;
  details?: TerminalSessionEventDetails;
}

export interface TerminalSessionEventQuery {
  authorizedWorkspaceIds: ReadonlySet<string>;
  workspaceId?: string | null;
  sessionName?: string | null;
  afterId?: number | null;
  limit?: number;
}

export interface TerminalSessionEventPayload {
  version: typeof TERMINAL_SESSION_EVENT_PAYLOAD_VERSION;
  instanceId: string;
  startedAt: string;
  generatedAt: string;
  events: TerminalSessionEvent[];
}

const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 1_000;
const MAX_RETAINED_EVENTS = 4_000;

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_EVENT_LIMIT;
  return Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(value)));
}

export class TerminalSessionEventStore {
  // Event payloads are diagnostic metadata, not durable audit records. The
  // ingress pins a browser's WebSocket and polling traffic to one replica;
  // instanceId lets clients detect a rollout/restart and reset their cursor.
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private events: TerminalSessionEvent[] = [];
  private nextId = 1;

  record(input: RecordTerminalSessionEventInput): TerminalSessionEvent {
    const event: TerminalSessionEvent = {
      id: this.nextId,
      timestamp: new Date().toISOString(),
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      sessionName: input.sessionName,
      sessionKind: input.sessionKind,
      level: input.level ?? "info",
      type: input.type,
      details: input.details ?? {},
    };
    this.nextId += 1;
    this.events.push(event);
    if (this.events.length > MAX_RETAINED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_RETAINED_EVENTS);
    }
    return event;
  }

  list(query: TerminalSessionEventQuery): TerminalSessionEventPayload {
    const requestedWorkspaceId = query.workspaceId?.trim() || null;
    const requestedSessionName = query.sessionName?.trim() || null;
    const afterId = Number.isFinite(query.afterId) ? Math.max(0, query.afterId ?? 0) : 0;
    const limit = boundedLimit(query.limit);
    const events = this.events.filter((event) => {
      if (!query.authorizedWorkspaceIds.has(event.workspaceId)) return false;
      if (requestedWorkspaceId && event.workspaceId !== requestedWorkspaceId) return false;
      if (requestedSessionName && event.sessionName !== requestedSessionName) return false;
      return event.id > afterId;
    });

    return {
      version: TERMINAL_SESSION_EVENT_PAYLOAD_VERSION,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      generatedAt: new Date().toISOString(),
      events: afterId > 0 ? events.slice(0, limit) : events.slice(-limit),
    };
  }

  clear(): void {
    this.events = [];
    this.nextId = 1;
  }
}

export const terminalSessionEventStore = new TerminalSessionEventStore();
