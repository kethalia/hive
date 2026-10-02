// Control messages are text frames on this negotiated subprotocol. PTY output
// is always binary, so shell output can never impersonate a control message.
export const TERMINAL_SUBPROTOCOL = "hive-terminal-v1";
export const TERMINAL_READY = JSON.stringify({ type: "hive:ready" });

export function encodeTerminalPing(id: number): string {
  return JSON.stringify({ type: "hive:ping", id });
}

export function parseTerminalControl(
  data: unknown,
): { type: "hive:ready" } | { type: "hive:pong"; id: number } | null {
  if (typeof data !== "string" || data.length > 128) return null;
  try {
    const value = JSON.parse(data);
    if (value?.type === "hive:ready") return { type: "hive:ready" };
    if (value?.type === "hive:pong" && Number.isSafeInteger(value.id))
      return { type: "hive:pong", id: value.id };
  } catch {
    /* Not a control frame. */
  }
  return null;
}

interface PtyClientMessage {
  data?: string;
  height?: number;
  width?: number;
}

export function encodeInput(data: string): string {
  return JSON.stringify({ data });
}

export function encodeResize(rows: number, cols: number): string {
  const msg: PtyClientMessage = {};
  if (rows > 0) msg.height = rows;
  if (cols > 0) msg.width = cols;
  return JSON.stringify(msg);
}

export function decodeOutput(frame: ArrayBuffer | string): Uint8Array | string {
  if (typeof frame === "string") return frame;
  return new Uint8Array(frame);
}
