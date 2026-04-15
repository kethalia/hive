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
