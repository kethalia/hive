export const TERMINAL_SESSION_EVENT_PAYLOAD_VERSION = 1;

export type TerminalSessionKind = "git" | "terminal";
export type TerminalSessionEventLevel = "error" | "info" | "warning";

export interface TerminalSessionEvent {
  id: number;
  timestamp: string;
  workspaceId: string;
  connectionId: string;
  sessionName: string;
  sessionKind: TerminalSessionKind;
  level: TerminalSessionEventLevel;
  type: string;
  details: Record<string, boolean | number | string | null>;
}

export interface TerminalSessionEventPayload {
  version: typeof TERMINAL_SESSION_EVENT_PAYLOAD_VERSION;
  instanceId: string;
  startedAt: string;
  generatedAt: string;
  events: TerminalSessionEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): Record<string, boolean | number | string | null> | null {
  if (!isRecord(value)) return null;
  const details: Record<string, boolean | number | string | null> = {};
  for (const [key, detail] of Object.entries(value)) {
    if (
      detail === null ||
      typeof detail === "boolean" ||
      typeof detail === "number" ||
      typeof detail === "string"
    ) {
      details[key] = detail;
    }
  }
  return details;
}

interface TerminalSessionEventIdentity {
  id: number;
  timestamp: string;
  workspaceId: string;
  connectionId: string;
  sessionName: string;
  type: string;
}

function parseEventIdentity(value: Record<string, unknown>): TerminalSessionEventIdentity | null {
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return null;
  const stringFields = [
    value.timestamp,
    value.workspaceId,
    value.connectionId,
    value.sessionName,
    value.type,
  ];
  if (!stringFields.every((field) => typeof field === "string")) return null;
  const [timestamp, workspaceId, connectionId, sessionName, type] = stringFields;
  if (
    typeof timestamp !== "string" ||
    typeof workspaceId !== "string" ||
    typeof connectionId !== "string" ||
    typeof sessionName !== "string" ||
    typeof type !== "string"
  ) {
    return null;
  }
  return { id: value.id, timestamp, workspaceId, connectionId, sessionName, type };
}

function parseSessionKind(value: unknown): TerminalSessionKind | null {
  return value === "git" || value === "terminal" ? value : null;
}

function parseEventLevel(value: unknown): TerminalSessionEventLevel | null {
  return value === "error" || value === "info" || value === "warning" ? value : null;
}

function parseEvent(value: unknown): TerminalSessionEvent | null {
  if (!isRecord(value)) return null;
  const identity = parseEventIdentity(value);
  const details = parseDetails(value.details);
  const sessionKind = parseSessionKind(value.sessionKind);
  const level = parseEventLevel(value.level);
  if (!identity || !details || !sessionKind || !level) return null;
  return {
    ...identity,
    sessionKind,
    level,
    details,
  };
}

export function parseTerminalSessionEventPayload(
  value: unknown,
): TerminalSessionEventPayload | null {
  if (!isRecord(value) || value.version !== TERMINAL_SESSION_EVENT_PAYLOAD_VERSION) return null;
  if (
    typeof value.instanceId !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.events)
  ) {
    return null;
  }
  const events = value.events.flatMap((event) => {
    const parsed = parseEvent(event);
    return parsed ? [parsed] : [];
  });
  return {
    version: TERMINAL_SESSION_EVENT_PAYLOAD_VERSION,
    instanceId: value.instanceId,
    startedAt: value.startedAt,
    generatedAt: value.generatedAt,
    events,
  };
}
