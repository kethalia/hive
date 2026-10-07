import type { WebSocket } from "ws";

type Notification = { method: string; params?: Record<string, unknown> };

export class VoiceRequestRejected extends Error {}

/** A private, bounded RPC connection. Never expose arbitrary methods to the browser. */
export class VoiceRpc {
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  onNotification: (notification: Notification) => void = () => {};
  onClose: () => void = () => {};

  constructor(
    private socket: WebSocket,
    private dispose: () => void = () => {},
  ) {
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.close();
        return;
      }
      if (!message || typeof message !== "object") {
        this.close();
        return;
      }
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (pending) {
        this.pending.delete(message.id as number);
        clearTimeout(pending.timer);
        if (message.error) {
          // Upstream messages can include credentials/URLs. Keep them server-side.
          pending.reject(
            new VoiceRequestRejected(
              "Codex rejected the voice request. Check its version, sign-in, and voice availability.",
            ),
          );
        } else pending.resolve(message.result);
      } else if (typeof message.method === "string" && message.id === undefined) {
        this.onNotification(message as Notification);
      }
      // Do not answer server approval/elicitation requests. The existing TUI owns them.
    });
    socket.on("error", () => this.close());
    socket.on("close", () => {
      this.rejectPending();
      this.dispose();
      this.onClose();
    });
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (this.socket.readyState !== 1) return Promise.reject(new Error("Codex connection closed"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex voice request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Codex connection closed"));
      });
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "hive_voice", title: "Hive Voice", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.socket.send(JSON.stringify({ method: "initialized" }));
  }

  private rejectPending() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex connection closed"));
    }
    this.pending.clear();
  }

  close() {
    this.rejectPending();
    this.socket.terminate();
    this.dispose();
  }
}
