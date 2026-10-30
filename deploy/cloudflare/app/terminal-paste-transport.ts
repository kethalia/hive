import { randomUUID } from "node:crypto";
import { publicationFetch } from "../../../src/lib/templates/publication-io";
import { terminalPasteWriterCommand } from "../../../src/lib/workspace/paste-writer";
import type { RelaySocket } from "./project-relay";

type Frame = Record<string, unknown>;
export type PasteFile = { name: string; bytes: Uint8Array; sha256: string };
const close = (socket?: RelaySocket) => {
  try {
    socket?.close(1000, "Paste transport closed");
  } catch {}
};
/** Fixed provider URL/command. A lost ACK is uncertain: never reconnect/retry writes. */
export async function transferTerminalPaste(input: {
  origin: string;
  agentId: string;
  token: string;
  files: PasteFile[];
  signal: AbortSignal;
  authorize(): Promise<void>;
  fetch?: typeof fetch;
}) {
  const nonce = randomUUID().replaceAll("-", "");
  const url = new URL(`/api/v2/workspaceagents/${input.agentId}/pty`, input.origin);
  url.search = new URLSearchParams({
    reconnect: randomUUID(),
    width: "80",
    height: "24",
    command: terminalPasteWriterCommand(nonce),
  }).toString();
  const handshake = new AbortController();
  const handshakeSignal = AbortSignal.any([input.signal, handshake.signal]);
  const handshakeTimer = setTimeout(() => handshake.abort(), 10000);
  const fetching = (input.fetch ?? fetch)(url, {
    redirect: "manual",
    credentials: "omit",
    signal: handshakeSignal,
    headers: { Upgrade: "websocket", "Coder-Session-Token": input.token },
  });
  void fetching.then(
    (late) => {
      const socket = (late as Response & { webSocket?: RelaySocket }).webSocket;
      if (handshakeSignal.aborted && socket) {
        try {
          socket.accept({ allowHalfOpen: true });
        } catch {}
        close(socket);
      }
    },
    () => {},
  );
  let response: Response;
  try {
    response = await publicationFetch(fetching, handshakeSignal);
  } finally {
    clearTimeout(handshakeTimer);
  }
  const socket = (response as Response & { webSocket?: RelaySocket }).webSocket;
  if (response.status !== 101 || response.redirected || !socket) {
    if (socket) {
      try {
        socket.accept({ allowHalfOpen: true });
      } catch {}
      close(socket);
    }
    void response.body?.cancel().catch(() => {});
    throw new Error("paste_transport");
  }
  let output = "",
    received = 0,
    messages = 0,
    failed = false;
  const frames: Frame[] = [];
  let waiting: { resolve(value: Frame): void; reject(error: Error): void } | undefined;
  const fail = () => {
    failed = true;
    waiting?.reject(new Error("paste_transport"));
    waiting = undefined;
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const message = (event: { data: unknown }) => {
    try {
      const raw = event.data;
      if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) throw new Error("binary");
      const bytes =
        raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      received += bytes.byteLength;
      if (bytes.byteLength > 8192 || received > 1048576 || ++messages > 8192)
        throw new Error("output");
      output += decoder.decode(bytes, { stream: true });
      if (output.length > 8192) throw new Error("line");
      while (output.includes("\n")) {
        const end = output.indexOf("\n");
        const value = JSON.parse(output.slice(0, end));
        output = output.slice(end + 1);
        if (!value || Array.isArray(value) || value.nonce !== nonce || value.type === "error")
          throw new Error("scope");
        if (waiting) {
          const current = waiting;
          waiting = undefined;
          current.resolve(value);
        } else {
          if (frames.length >= 2) throw new Error("queue");
          frames.push(value);
        }
      }
    } catch {
      fail();
      close(socket);
    }
  };
  const next = async () => {
    input.signal.throwIfAborted();
    const queued = frames.shift();
    if (queued) return queued;
    if (failed) throw new Error("paste_transport");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Frame>((resolve, reject) => {
        waiting = { resolve, reject };
        timer = setTimeout(() => {
          fail();
        }, 5000);
      });
    } finally {
      clearTimeout(timer);
      waiting = undefined;
    }
  };
  const expect = async (expected: Frame) => {
    const value = await next();
    const wanted = { nonce, ...expected };
    if (
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(wanted).sort()) ||
      Object.entries(wanted).some(([key, v]) => value[key] !== v)
    )
      throw new Error("paste_ack");
  };
  const send = (value: unknown) => {
    input.signal.throwIfAborted();
    if (failed || (socket.bufferedAmount ?? 0) > 65536) throw new Error("paste_transport");
    // Coder reconnecting PTY consumes binary JSON envelopes, never raw WS text.
    socket.send(new TextEncoder().encode(JSON.stringify({ data: `${JSON.stringify(value)}\n` })));
  };
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", message);
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);
  input.signal.addEventListener("abort", fail, { once: true });
  try {
    socket.accept({ allowHalfOpen: true });
    await expect({ type: "ready" });
    await input.authorize();
    send({
      files: input.files.map(({ name, bytes, sha256 }) => ({
        name,
        size: bytes.byteLength,
        sha256,
      })),
    });
    await expect({ type: "manifest" });
    const paths: string[] = [];
    for (const [index, file] of input.files.entries()) {
      await input.authorize();
      send({ type: "file", index });
      for (
        let offset = 0, sequence = 0;
        offset < file.bytes.byteLength;
        offset += 16384, sequence++
      ) {
        await input.authorize();
        send({
          sequence,
          data: Buffer.from(file.bytes.subarray(offset, offset + 16384)).toString("base64"),
        });
        await expect({ type: "chunk", index, sequence });
      }
      const path = `/tmp/hive-terminal-paste/${file.name}`;
      await expect({ type: "file", index, size: file.bytes.byteLength, sha256: file.sha256, path });
      paths.push(path);
    }
    await expect({ type: "complete" });
    await input.authorize();
    return paths;
  } finally {
    input.signal.removeEventListener("abort", fail);
    socket.removeEventListener("message", message);
    socket.removeEventListener("close", fail);
    socket.removeEventListener("error", fail);
    close(socket);
  }
}
