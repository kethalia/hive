import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { SAFE_IDENTIFIER_RE, UUID_RE } from "@/lib/constants";
import { buildPtyUrl } from "./protocol";

const PING_INTERVAL_MS = 30_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

const wss = new WebSocketServer({ noServer: true });

export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const token = process.env.CODER_SESSION_TOKEN;
  if (!token) {
    console.error("[terminal-proxy] CODER_SESSION_TOKEN not set — rejecting upgrade");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const agentId = url.searchParams.get("agentId");
  const reconnectId = url.searchParams.get("reconnectId");
  const width = url.searchParams.get("width");
  const height = url.searchParams.get("height");
  const sessionName = url.searchParams.get("sessionName") ?? "default";

  if (!agentId || !reconnectId) {
    console.error("[terminal-proxy] Missing required params: agentId, reconnectId");
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!UUID_RE.test(agentId)) {
    console.error(`[terminal-proxy] Invalid agentId format: ${agentId}`);
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!SAFE_IDENTIFIER_RE.test(sessionName)) {
    console.error(`[terminal-proxy] Unsafe sessionName: ${sessionName}`);
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const coderUrl = process.env.CODER_URL ?? process.env.CODER_AGENT_URL ?? "";
  const upstreamUrl = buildPtyUrl(coderUrl, agentId, {
    reconnectId,
    width: Number(width) || 80,
    height: Number(height) || 24,
    sessionName,
  });

  wss.handleUpgrade(req, socket, head, (browserWs) => {
    wss.emit("connection", browserWs, req);
    connectUpstream(browserWs, upstreamUrl, token, agentId);
  });
}

function connectUpstream(
  browserWs: WebSocket,
  upstreamUrl: string,
  token: string,
  agentId: string,
): void {
  console.log(`[terminal-proxy] connecting upstream agent=${agentId}`);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { "Coder-Session-Token": token },
    handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
  });

  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
    if (browserWs.readyState === WebSocket.OPEN || browserWs.readyState === WebSocket.CONNECTING) {
      browserWs.close();
    }
  }

  upstream.on("open", () => {
    console.log(`[terminal-proxy] upstream connected agent=${agentId}`);
    pingTimer = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.ping();
      }
    }, PING_INTERVAL_MS);
  });

  upstream.on("message", (data, isBinary) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(data, { binary: isBinary });
    }
  });

  upstream.on("error", (err) => {
    console.error(`[terminal-proxy] upstream error agent=${agentId}: ${err.message}`);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.close(1011, "upstream error");
    }
    cleanup();
  });

  upstream.on("close", (code, reason) => {
    console.log(`[terminal-proxy] upstream closed agent=${agentId} code=${code}`);
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.close(code, reason);
    }
    cleanup();
  });

  browserWs.on("message", (data) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    }
  });

  browserWs.on("close", () => {
    console.log(`[terminal-proxy] browser disconnected agent=${agentId}`);
    cleanup();
  });

  browserWs.on("error", (err) => {
    console.error(`[terminal-proxy] browser error agent=${agentId}: ${err.message}`);
    cleanup();
  });

  setTimeout(() => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      console.error(`[terminal-proxy] upstream connect timeout agent=${agentId}`);
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close(1013, "upstream connect timeout");
      }
      cleanup();
    }
  }, UPSTREAM_CONNECT_TIMEOUT_MS);
}
