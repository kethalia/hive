type Message = { data: unknown };
type Closed = { code?: number };
export interface RelaySocket {
  readyState: number;
  bufferedAmount?: number;
  binaryType?: "arraybuffer" | "blob";
  accept(options?: { allowHalfOpen: boolean }): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "message", listener: (event: Message) => void): void;
  addEventListener(event: "close", listener: (event: Closed) => void): void;
  addEventListener(event: "error", listener: () => void): void;
  removeEventListener(event: string, listener: unknown): void;
}
export type UpgradeResponse = {
  status: number;
  webSocket?: RelaySocket;
  body?: ReadableStream<Uint8Array> | null;
};
