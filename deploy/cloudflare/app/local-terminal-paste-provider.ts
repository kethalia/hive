// Explicit provider double; no real workspace/file effect or deployed import.

import { terminalPasteWriterCommand } from "../../../src/lib/workspace/paste-writer";
import base from "./local-generic-terminal-provider";
import type { RelaySocket } from "./project-relay";

let mode = "normal",
  attempts = 0,
  completed = 0;
const accepted: { size: number; sha256: string }[] = [];
export default {
  async fetch(request: Request, env: { PROOF_BEARER: string; AUTH_SERVICE_SECRET: string }) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__paste/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`)
        return new Response(null, { status: 401 });
      if (url.pathname === "/__paste/mode") mode = await request.text();
      return Response.json({ mode, attempts, completed, accepted });
    }
    if (!url.pathname.endsWith("/pty")) return base.fetch(request, env);
    const command = url.searchParams.get("command") ?? "",
      nonce = command.split(" ").at(-1) ?? "";
    if (
      request.headers.get("Coder-Session-Token") !== "synthetic-coder-token" ||
      request.headers.has("Cookie") ||
      request.headers.has("Authorization") ||
      command !== terminalPasteWriterCommand(nonce)
    )
      return new Response(null, { status: 403 });
    attempts++;
    const runtime = globalThis as typeof globalThis & {
      WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket };
    };
    const pair = new runtime.WebSocketPair(),
      socket = pair[1];
    let files: { name: string; size: number; sha256: string }[] = [],
      index = 0,
      parts: Uint8Array[] = [];
    const send = (value: object) =>
      socket.send(new TextEncoder().encode(`${JSON.stringify({ nonce, ...value })}\n`));
    const finish = async () => {
      const all = Buffer.concat(parts),
        sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", all)).toString("hex");
      if (all.length !== files[index].size || sha256 !== files[index].sha256) {
        socket.close(1008, "fixture");
        return;
      }
      accepted.push({ size: all.length, sha256 });
      if (mode === "close") {
        socket.close(1000, "fixture unknown");
        return;
      }
      send({
        type: "file",
        index,
        size: all.length,
        sha256,
        path: `/tmp/hive-terminal-paste/${mode === "wrong-path" ? "mismatched" : files[index].name}`,
      });
      if (index === files.length - 1) {
        completed++;
        send({ type: "complete" });
      }
    };
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      void (async () => {
        if (!(event.data instanceof ArrayBuffer)) throw new Error("binary");
        const envelope = JSON.parse(new TextDecoder().decode(event.data)),
          value = JSON.parse(envelope.data);
        if (value.files) {
          files = value.files;
          send({ type: "manifest" });
        } else if (value.type === "file") {
          index = value.index;
          parts = [];
          if (!files[index].size) await finish();
        } else {
          parts.push(Buffer.from(value.data, "base64"));
          send({ type: "chunk", index, sequence: value.sequence });
          if (parts.reduce((sum, p) => sum + p.length, 0) === files[index].size) await finish();
        }
      })().catch(() => socket.close(1008, "fixture rejected"));
    });
    socket.accept({ allowHalfOpen: true });
    send({ type: "ready" });
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  },
};
