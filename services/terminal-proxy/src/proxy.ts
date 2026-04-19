import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { SAFE_IDENTIFIER_RE, UUID_RE, buildPtyUrl } from "./protocol.js";
import { ConnectionRegistry } from "./keepalive.js";
import { authenticateUpgrade } from "./auth.js";

const PING_INTERVAL_MS = 30_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

export const connectionRegistry = new ConnectionRegistry();

/**
 * Parse ALLOWED_ORIGINS env var into a list of allowed origin patterns.
 * Supports exact matches and wildcard ports (e.g. "http://localhost:*").
 * If not set, defaults to allowing only localhost origins.
 */
let cachedOrigins: string[] | null = null;
let cachedOriginsEnv: string | undefined;

function getAllowedOrigins(): string[] {
  const env = process.env.ALLOWED_ORIGINS?.trim();
  if (cachedOrigins && cachedOriginsEnv === env) return cachedOrigins;
  cachedOriginsEnv = env;
  if (env) {
    cachedOrigins = env.split(",").map((o) => o.trim()).filter(Boolean);
  } else {
    cachedOrigins = ["http://localhost:*", "https://localhost:*"];
  }
  return cachedOrigins;
}

function originMatchesPattern(origin: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    // Convert wildcard pattern to regex: escape dots, replace * with .*
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(origin);
  }
  return origin === pattern;
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  const patterns = getAllowedOrigins();
  return patterns.some((pattern) => originMatchesPattern(origin, pattern));
}

export async function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const origin = req.headers.origin as string | undefined;
  if (!isOriginAllowed(origin)) {
    console.error(`[terminal-proxy] Origin rejected: ${origin ?? "(none)"}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const agentId = url.searchParams.get("agentId");
  const reconnectId = url.searchParams.get("reconnectId");
  const workspaceId = url.searchParams.get("workspaceId");

  if (workspaceId && !UUID_RE.test(workspaceId)) {
    console.error(`[terminal-proxy] Invalid workspaceId format: ${workspaceId}`);
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

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

  if (!UUID_RE.test(reconnectId)) {
    console.error(`[terminal-proxy] Invalid reconnectId format: ${reconnectId}`);
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

  const authResult = await authenticateUpgrade(req);
  if (!authResult.ok) {
    const reasonPhrase = authResult.value.status === 401 ? "Unauthorized" : "Bad Gateway";
    socket.write(`HTTP/1.1 ${authResult.value.status} ${reasonPhrase}\r\n\r\n`);
    socket.destroy();
    return;
  }

  const { token, coderUrl: authCoderUrl } = authResult.value;
  const coderUrl = authCoderUrl || process.env.CODER_URL || process.env.CODER_AGENT_URL || "";
  if (!coderUrl) {
    console.error("[terminal-proxy] No coderUrl from auth or env — rejecting upgrade");
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstreamUrl = buildPtyUrl(coderUrl, agentId, {
    reconnectId,
    width: Number(width) || 80,
    height: Number(height) || 24,
    sessionName,
  });

  const connectionId = randomUUID();

  wss.handleUpgrade(req, socket, head, (browserWs) => {
    wss.emit("connection", browserWs, req);

    if (workspaceId) {
      connectionRegistry.addConnection(workspaceId, connectionId, {
        token,
        coderUrl,
      });
      browserWs.on("close", () => {
        connectionRegistry.removeConnection(workspaceId, connectionId);
      });
    }

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
