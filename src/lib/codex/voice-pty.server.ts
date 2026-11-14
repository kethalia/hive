import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { RelaySocket } from "@/lib/terminal/relay-types";
import { cancelTerminalBody, terminalFetch } from "@/lib/terminal/transport-io";
import type { authorizeOwnedWorkspacePty } from "../../../deploy/cloudflare/app/generic-terminal-runtime";
import { VOICE_PTY_SCRIPT } from "./voice-pty-script";
import { VoiceRpc, type VoiceSocket } from "./voice-rpc";

type Authority = Awaited<ReturnType<typeof authorizeOwnedWorkspacePty>>;
type Dependencies = {
  authorize(signal: AbortSignal): Promise<Authority>;
  fetch?: typeof fetch;
  track(promise: Promise<void>): void;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximum = 2 * 1024 * 1024;
const compressedScript = deflateSync(VOICE_PTY_SCRIPT).toString("base64");
export function voicePtyCommand(nonce: string, seconds: number, threadId?: string) {
  if (
    !UUID.test(nonce) ||
    (threadId && !UUID.test(threadId)) ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 1800
  )
    throw Error("voice_scope_invalid");
  return `python3 -I -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode("${compressedScript}")))' ${nonce} ${threadId ?? "-"} ${seconds}`;
}

function closeUpgrade(socket?: RelaySocket) {
  if (!socket) return;
  try {
    socket.accept({ allowHalfOpen: true });
  } catch {
    /* It may already be accepted. */
  }
  try {
    socket.close(1000, "Voice closed");
  } catch {
    /* Already closed. */
  }
}

class PtyVoiceSocket implements VoiceSocket {
  readyState = 0;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  private open!: () => void;
  private rejectOpen!: (error: Error) => void;
  private finishClosed!: () => void;
  private messages = new Set<(raw: { toString(): string }) => void>();
  private closes = new Set<() => void>();
  private errors = new Set<() => void>();
  private prefix: string;
  private text = "";
  private wire = 0;
  private ready = false;
  private closedOnce = false;
  private inputSequence = 0;
  private outputSequence = 0;
  private outputIndex = 0;
  private output: Uint8Array[] = [];
  private outputBytes = 0;
  private queue = Promise.resolve();
  private queued = 0;
  private ack?: {
    value: string;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  private heartbeat?: ReturnType<typeof setInterval>;
  private closingTimer?: ReturnType<typeof setTimeout>;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(
    private socket: RelaySocket,
    nonce: string,
    private beforeStart: () => Promise<void>,
  ) {
    this.prefix = `HIVE_VOICE_${nonce}:`;
    this.opened = new Promise((resolve, reject) => {
      this.open = resolve;
      this.rejectOpen = reject;
    });
    void this.opened.catch(() => {});
    this.closed = new Promise((resolve) => {
      this.finishClosed = resolve;
    });
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", this.message);
    socket.addEventListener("close", this.failed);
    socket.addEventListener("error", this.failed);
  }
  accept() {
    try {
      this.socket.accept({ allowHalfOpen: true });
    } catch {
      this.failed();
      throw Error("Codex voice unavailable");
    }
  }
  on(event: "message", listener: (raw: { toString(): string }) => void): void;
  on(event: "error" | "close", listener: () => void): void;
  on(
    event: "message" | "error" | "close",
    listener: ((raw: { toString(): string }) => void) | (() => void),
  ) {
    if (event === "message") this.messages.add(listener);
    else if (event === "error") this.errors.add(listener as () => void);
    else this.closes.add(listener as () => void);
  }
  private control(value: string) {
    this.socket.send(
      new TextEncoder().encode(JSON.stringify({ data: `${this.prefix}${value}\n` })),
    );
  }
  private message = ({ data }: { data: unknown }) => {
    try {
      if (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
        throw Error("voice_frame_invalid");
      this.wire += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      if (this.wire > 16 * maximum) throw Error("voice_wire_limit");
      this.text += typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
      while (this.text.includes("\n")) {
        const at = this.text.indexOf("\n");
        const line = this.text.slice(0, at).replace(/\r$/, "");
        this.text = this.text.slice(at + 1);
        this.frame(line);
      }
      if (this.text.length > (this.ready ? 4096 : 16384)) throw Error("voice_frame_limit");
    } catch {
      this.failed();
    }
  };
  private frame(line: string) {
    if (!line.startsWith(this.prefix)) {
      if (this.ready) throw Error("voice_frame_invalid");
      return;
    }
    const value = line.slice(this.prefix.length);
    if (this.closedOnce && value !== "CLOSED:") return;
    if (!this.ready && value === "READY:") {
      this.ready = true;
      this.control("GO:");
      this.heartbeat = setInterval(() => {
        try {
          this.control("PING:");
        } catch {
          this.failed();
        }
      }, 5000);
    } else if (this.readyState === 0 && this.ready && value === "OPEN:") {
      this.readyState = 1;
      this.open();
    } else if (value === "CLOSED:") {
      this.terminate();
      this.cleanup();
    } else if (this.readyState === 1 && value.startsWith("ACK:")) {
      if (!this.ack || value !== this.ack.value) throw Error("voice_ack_invalid");
      clearTimeout(this.ack.timer);
      this.ack.resolve();
      this.ack = undefined;
    } else if (this.readyState === 1 && value.startsWith("OUT:")) {
      const fields = value.split(":");
      if (
        fields.length !== 5 ||
        fields[1] !== String(this.outputSequence) ||
        fields[2] !== String(this.outputIndex) ||
        !["0", "1"].includes(fields[3])
      )
        throw Error("voice_sequence_invalid");
      const bytes = Buffer.from(fields[4], "base64");
      if (!bytes.length || bytes.length > 2048 || bytes.toString("base64") !== fields[4])
        throw Error("voice_data_invalid");
      this.outputBytes += bytes.length;
      if (this.outputBytes > maximum) throw Error("voice_payload_limit");
      this.output.push(bytes);
      this.control(`RECEIVED:${this.outputSequence}:${this.outputIndex}`);
      if (fields[3] === "1") {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.output));
        this.output = [];
        this.outputBytes = 0;
        this.outputIndex = 0;
        this.outputSequence++;
        for (const listener of this.messages) listener(raw);
      } else this.outputIndex++;
    } else throw Error("voice_frame_invalid");
  }
  send(data: string, callback?: (error?: Error) => void) {
    const payload = new TextEncoder().encode(data);
    if (
      this.readyState !== 1 ||
      !payload.length ||
      payload.byteLength > 128 * 1024 ||
      this.queued >= 16
    ) {
      callback?.(Error("Codex connection closed"));
      this.terminate();
      return;
    }
    this.queued++;
    this.queue = this.queue
      .then(async () => {
        if (JSON.parse(data).method === "thread/realtime/start") await this.beforeStart();
        const sequence = this.inputSequence++;
        for (let offset = 0, index = 0; offset < payload.byteLength; offset += 2048, index++) {
          if (this.readyState !== 1) throw Error("Codex connection closed");
          const bytes = payload.subarray(offset, offset + 2048);
          await new Promise<void>((resolve, reject) => {
            this.ack = {
              value: `ACK:${sequence}:${index}`,
              resolve,
              reject,
              timer: setTimeout(() => reject(Error("Codex transport timed out")), 3000),
            };
            try {
              this.control(
                `IN:${sequence}:${index}:${Number(offset + bytes.length === payload.length)}:${Buffer.from(bytes).toString("base64")}`,
              );
            } catch {
              reject(Error("Codex connection closed"));
            }
          });
        }
        callback?.();
      })
      .catch(() => {
        callback?.(Error("Codex connection closed"));
        this.failed();
      })
      .finally(() => {
        this.queued--;
      });
  }
  private failed = () => {
    for (const listener of this.errors) listener();
    this.terminate();
    this.cleanup();
  };
  terminate() {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.readyState = 3;
    clearInterval(this.heartbeat);
    if (this.ack) {
      clearTimeout(this.ack.timer);
      this.ack.reject(Error("Codex connection closed"));
      this.ack = undefined;
    }
    this.rejectOpen(Error("Codex connection closed"));
    try {
      this.control("CANCEL:");
    } catch {
      /* The remote idle timeout remains bounded. */
    }
    this.closingTimer = setTimeout(() => this.cleanup(), 4000);
    for (const listener of this.closes) listener();
  }
  private cleanup() {
    clearTimeout(this.closingTimer);
    clearInterval(this.heartbeat);
    this.socket.removeEventListener("message", this.message);
    this.socket.removeEventListener("close", this.failed);
    this.socket.removeEventListener("error", this.failed);
    closeUpgrade(this.socket);
    void this.queue.finally(this.finishClosed);
  }
}

/** Server-only voice signaling; the HTTP route supplies session-derived scope. */
export async function openVoicePty(
  dependencies: Dependencies,
  callerSignal: AbortSignal,
  threadId?: string,
) {
  if (threadId && !UUID.test(threadId)) throw Error("Invalid Codex thread");
  const controller = new AbortController();
  const abort = () => controller.abort();
  callerSignal.addEventListener("abort", abort, { once: true });
  const setup = setTimeout(abort, 25000);
  let socket: PtyVoiceSocket | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  const finish = () => {
    controller.abort();
    clearTimeout(setup);
    clearTimeout(lifetime);
    clearInterval(renewal);
    callerSignal.removeEventListener("abort", abort);
  };
  try {
    callerSignal.throwIfAborted();
    const authority = await dependencies.authorize(controller.signal);
    controller.signal.throwIfAborted();
    let expiresAt = Math.min(authority.expiresAt, Date.now() + 1800000);
    lifetime = setTimeout(abort, Math.max(1, expiresAt - Date.now()));
    const identity = (value: Authority) =>
      JSON.stringify([
        value.sessionId,
        value.userId,
        value.coderUserId,
        value.coderOrigin,
        value.buildId,
        value.agentId,
      ]);
    const reauthorize = async () => {
      const current = await dependencies.authorize(
        AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      );
      if (identity(current) !== identity(authority) || current.expiresAt <= Date.now())
        throw Error("Voice authorization changed");
      expiresAt = Math.min(expiresAt, current.expiresAt);
      if (expiresAt <= Date.now()) throw Error("Voice authorization expired");
      if (lifetime) {
        clearTimeout(lifetime);
        lifetime = setTimeout(abort, Math.max(1, expiresAt - Date.now()));
      }
    };
    const seconds = Math.floor((expiresAt - Date.now()) / 1000);
    if (seconds < 1) throw Error("Voice authorization expired");
    const url = new URL(`/api/v2/workspaceagents/${authority.agentId}/pty`, authority.coderOrigin);
    const nonce = randomUUID();
    url.search = new URLSearchParams({
      reconnect: randomUUID(),
      width: "512",
      height: "128",
      command: voicePtyCommand(nonce, seconds, threadId),
    }).toString();
    const upgrade = (dependencies.fetch ?? fetch)(url, {
      headers: { Upgrade: "websocket", "Coder-Session-Token": authority.token },
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    void upgrade.then(
      (response) => {
        if (controller.signal.aborted)
          closeUpgrade((response as Response & { webSocket?: RelaySocket }).webSocket);
      },
      () => {},
    );
    const response = await terminalFetch(upgrade, controller.signal);
    const upstream = (response as Response & { webSocket?: RelaySocket }).webSocket;
    if (response.status !== 101 || response.redirected || !upstream) {
      closeUpgrade(upstream);
      await cancelTerminalBody(response);
      throw Error("Codex voice unavailable");
    }
    socket = new PtyVoiceSocket(upstream, nonce, reauthorize);
    const rpc = new VoiceRpc(socket);
    const connected = socket;
    const closeOnAbort = () => connected.terminate();
    controller.signal.addEventListener("abort", closeOnAbort, { once: true });
    dependencies.track(
      connected.closed.finally(async () => {
        finish();
        await refreshing?.catch(() => {});
      }),
    );
    socket.accept();
    await socket.opened;
    await reauthorize();
    await rpc.initialize();
    controller.signal.throwIfAborted();
    clearTimeout(setup);
    callerSignal.removeEventListener("abort", abort);
    const refresh = () => {
      if (refreshing) return;
      refreshing = reauthorize()
        .catch(() => connected.terminate())
        .finally(() => {
          refreshing = undefined;
        });
    };
    renewal = setInterval(refresh, 60000);
    return rpc;
  } catch (error) {
    finish();
    socket?.terminate();
    throw error;
  }
}
