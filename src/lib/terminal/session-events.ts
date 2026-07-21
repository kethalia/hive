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

function parseEvent(value: unknown): TerminalSessionEvent | null {
  if (!isRecord(value)) return null;
  const details = parseDetails(value.details);
  const sessionKind = value.sessionKind;
  const level = value.level;
  if (
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.timestamp !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.connectionId !== "string" ||
    typeof value.sessionName !== "string" ||
    (sessionKind !== "git" && sessionKind !== "terminal") ||
    (level !== "error" && level !== "info" && level !== "warning") ||
    typeof value.type !== "string" ||
    !details
  ) {
    return null;
  }
  return {
    id: value.id,
    timestamp: value.timestamp,
    workspaceId: value.workspaceId,
    connectionId: value.connectionId,
    sessionName: value.sessionName,
    sessionKind,
    level,
    type: value.type,
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
