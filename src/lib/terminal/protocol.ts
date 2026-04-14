import { SAFE_IDENTIFIER_RE } from "@/lib/constants";

// ── Types ─────────────────────────────────────────────────────────

export interface PtyClientMessage {
  data?: string;
  height?: number;
  width?: number;
}

export interface PtyConnectionOptions {
  reconnectId: string;
  width: number;
  height: number;
  sessionName: string;
}

// ── Encoders ──────────────────────────────────────────────────────

export function encodeInput(data: string): string {
  return JSON.stringify({ data });
}

export function encodeResize(rows: number, cols: number): string {
  const msg: PtyClientMessage = {};
  if (rows > 0) msg.height = rows;
  if (cols > 0) msg.width = cols;
  return JSON.stringify(msg);
}

// ── Decoder ───────────────────────────────────────────────────────

export function decodeOutput(frame: ArrayBuffer | string): Uint8Array | string {
  if (typeof frame === "string") return frame;
  return new Uint8Array(frame);
}

// ── URL Builder ───────────────────────────────────────────────────

export function buildPtyUrl(
  baseUrl: string,
  agentId: string,
  options: PtyConnectionOptions,
): string {
  const { reconnectId, width, height, sessionName } = options;

  if (!SAFE_IDENTIFIER_RE.test(sessionName)) {
    throw new Error(
      `Invalid session name: "${sessionName}" — must match ${SAFE_IDENTIFIER_RE}`,
    );
  }

  let wsBase = baseUrl.replace(/\/+$/, "");
  if (wsBase.startsWith("https://")) {
    wsBase = "wss://" + wsBase.slice("https://".length);
  } else if (wsBase.startsWith("http://")) {
    wsBase = "ws://" + wsBase.slice("http://".length);
  }

  const command = `tmux new-session -A -s ${sessionName}`;
  const params = new URLSearchParams({
    reconnect: reconnectId,
    width: String(width),
    height: String(height),
    command,
  });

  return `${wsBase}/api/v2/workspaceagents/${agentId}/pty?${params.toString()}`;
}
