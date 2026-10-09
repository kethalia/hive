import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { authenticateUpgrade } from "./auth.js";
import { getCoderCaCertificates } from "./coder-fetch.js";
import { buildPtyUrl, SAFE_IDENTIFIER_RE, UUID_RE } from "./protocol.js";
import { isOriginAllowed } from "./proxy.js";
import { verifyWorkspaceAgentAccess } from "./workspace-authorization.js";

export const AUDIO_PROTOCOL = "hive-audio-v1";
const MAX_QUEUE = 64 * 1024;
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 2048,
  handleProtocols: (protocols) => (protocols.has(AUDIO_PROTOCOL) ? AUDIO_PROTOCOL : false),
});
let draining = false;

export function drainAudioConnections() {
  draining = true;
  for (const socket of wss.clients) socket.close(1012, "audio proxy restarting");
  return () => {
    for (const socket of wss.clients) socket.terminate();
  };
}

export function parseBrowserAudio(data: string): string | null {
  if (data.length > 2048) return null;
  try {
    const value = JSON.parse(data);
    if (value?.type === "ping" || value?.type === "release")
      return JSON.stringify({ type: value.type });
    if (
      value?.type === "microphone" &&
      typeof value.pcm === "string" &&
      value.pcm.length > 0 &&
      value.pcm.length <= 1280 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.pcm)
    ) {
      const pcm = Buffer.from(value.pcm, "base64");
      if (pcm.length > 0 && pcm.length <= 960 && pcm.length % 2 === 0)
        return JSON.stringify({ type: "microphone", pcm: value.pcm });
    }
  } catch {
    /* Malformed media is rejected without logging its contents. */
  }
  return null;
}

export function parseWorkspaceAudio(line: string): string | null {
  if (line.length > 2048) return null;
  try {
    const value = JSON.parse(line);
    if (value?.type === "ready" || value?.type === "pong")
      return JSON.stringify({ type: value.type });
    if (value?.type === "active" && typeof value.active === "boolean")
      return JSON.stringify({ type: "active", active: value.active });
    if (value?.type === "speaker") {
      const microphone = parseBrowserAudio(JSON.stringify({ type: "microphone", pcm: value.pcm }));
      if (microphone) return microphone.replace('"microphone"', '"speaker"');
    }
    if (value?.type === "error" && typeof value.message === "string")
      return JSON.stringify({
        type: "error",
        message: value.message.slice(0, 200),
        ...(value.code === "session_busy" ? { code: "session_busy" } : {}),
      });
  } catch {
    /* PTY diagnostics cannot impersonate audio frames. */
  }
  return null;
}

export function connectAudioRelay(browser: WebSocket, upstream: WebSocket) {
  let buffer = "";
  let closed = false;
  let lastPong = Date.now();
  let lastWorkspacePong = Date.now();
  const close = (code = 1000, message = "audio ended") => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(startup);
    if (upstream.readyState === WebSocket.OPEN)
      upstream.send(JSON.stringify({ data: '{"type":"release"}\n' }));
    upstream.close();
    browser.close(code, message);
  };
  const startup = setTimeout(() => close(1013, "workspace audio timed out"), 10_000);
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPong > 20_000 || Date.now() - lastWorkspacePong > 20_000) {
      close(1013, "audio heartbeat timed out");
      return;
    }
    if (upstream.readyState === WebSocket.OPEN)
      upstream.send(JSON.stringify({ data: '{"type":"ping"}\n' }));
    if (browser.readyState === WebSocket.OPEN) browser.ping();
  }, 5000);
  browser.on("pong", () => {
    lastPong = Date.now();
  });
  browser.on("message", (data, binary) => {
    if (binary) {
      close(1008, "invalid audio frame");
      return;
    }
    const message = parseBrowserAudio(data.toString());
    if (!message) {
      close(1008, "invalid audio frame");
      return;
    }
    if (message === '{"type":"release"}') {
      close();
      return;
    }
    // A browser heartbeat can arrive while Coder is still opening the PTY.
    if (upstream.readyState !== WebSocket.OPEN) {
      if (message !== '{"type":"ping"}') close(1008, "audio is not ready");
      return;
    }
    if (upstream.bufferedAmount > MAX_QUEUE) {
      close(1013, "audio connection stalled");
      return;
    }
    upstream.send(JSON.stringify({ data: `${message}\n` }));
  });
  upstream.on("message", (data) => {
    buffer += data.toString();
    if (buffer.length > MAX_QUEUE) {
      close(1008, "invalid workspace audio frame");
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const message = parseWorkspaceAudio(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      if (message && browser.readyState === WebSocket.OPEN) {
        if (message === '{"type":"ready"}' || message === '{"type":"pong"}')
          lastWorkspacePong = Date.now();
        if (message === '{"type":"ready"}') clearTimeout(startup);
        if (browser.bufferedAmount > MAX_QUEUE) {
          close(1013, "audio connection stalled");
          return;
        }
        browser.send(message);
      }
      newline = buffer.indexOf("\n");
    }
  });
  browser.once("close", () => close());
  browser.once("error", () => close(1011, "browser audio failed"));
  upstream.once("close", () => close(1013, "workspace audio closed"));
  upstream.once("error", () => close(1011, "workspace audio failed"));
}

export async function handleAudioUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const reject = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  };
  if (draining) {
    reject("503 Service Unavailable");
    return;
  }
  if (!isOriginAllowed(req.headers.origin)) {
    reject("403 Forbidden");
    return;
  }
  if (
    !(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((v) => v.trim())
      .includes(AUDIO_PROTOCOL)
  ) {
    reject("400 Bad Request");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  const agentId = url.searchParams.get("agentId") ?? "";
  const sessionName = url.searchParams.get("sessionName") ?? "";
  if (
    !UUID_RE.test(workspaceId) ||
    !UUID_RE.test(agentId) ||
    !SAFE_IDENTIFIER_RE.test(sessionName)
  ) {
    reject("400 Bad Request");
    return;
  }
  const auth = await authenticateUpgrade(req);
  if (!auth.ok) {
    reject(auth.value.status === 401 ? "401 Unauthorized" : "502 Bad Gateway");
    return;
  }
  const { token, coderUrl: authCoderUrl } = auth.value;
  const coderUrl = authCoderUrl || process.env.CODER_URL || process.env.CODER_AGENT_URL || "";
  if (!coderUrl) {
    reject("502 Bad Gateway");
    return;
  }
  const access = await verifyWorkspaceAgentAccess({ token, coderUrl, workspaceId, agentId });
  if (!access.ok) {
    reject(access.status === 403 ? "403 Forbidden" : "502 Bad Gateway");
    return;
  }
  if (socket.destroyed || draining) {
    reject("503 Service Unavailable");
    return;
  }
  const ca = getCoderCaCertificates();
  wss.handleUpgrade(req, socket, head, (browser) => {
    const upstream = new WebSocket(
      buildPtyUrl(coderUrl, agentId, {
        reconnectId: randomUUID(),
        width: 80,
        height: 24,
        sessionName,
        audioRelay: true,
      }),
      {
        headers: { "Coder-Session-Token": token },
        handshakeTimeout: 10_000,
        maxPayload: MAX_QUEUE,
        ...(ca ? { ca } : {}),
      },
    );
    connectAudioRelay(browser, upstream);
  });
}
