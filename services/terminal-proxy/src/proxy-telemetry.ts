import type {
  TerminalSessionEventDetails,
  TerminalSessionEventStore,
  TerminalSessionKind,
} from "./session-events.js";

export interface TerminalConnectionContext {
  connectionId: string;
  workspaceId: string;
  sessionName: string;
  sessionKind: TerminalSessionKind;
}

export function recordProxyEvent(
  eventStore: TerminalSessionEventStore,
  context: TerminalConnectionContext,
  type: Parameters<TerminalSessionEventStore["record"]>[0]["type"],
  details: TerminalSessionEventDetails = {},
  level: "error" | "info" | "warning" = "info",
): void {
  eventStore.record({ ...context, type, details, level });
}

export function messageByteLength(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + messageByteLength(part), 0);
  }
  return 0;
}

function textMessage(data: unknown): string | null {
  if (typeof data === "string") return data;
  return Buffer.isBuffer(data) ? data.toString() : null;
}

function resizeFrameDetails(text: string | null): TerminalSessionEventDetails | null {
  if (!text || text.length > 256) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const height = Reflect.get(parsed, "height");
    const width = Reflect.get(parsed, "width");
    if (typeof height !== "number" || typeof width !== "number") return null;
    return { frame: "resize", rows: height, cols: width };
  } catch {
    return null;
  }
}

export function browserMessageDetails(
  data: unknown,
  isBinary: boolean,
): TerminalSessionEventDetails {
  const details: TerminalSessionEventDetails = {
    bytes: messageByteLength(data),
    frame: isBinary ? "input" : "text",
  };
  if (isBinary) return details;
  const resize = resizeFrameDetails(textMessage(data));
  return resize ? { ...details, ...resize } : details;
}
