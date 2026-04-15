import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

import { createServer } from "node:http";
import { handleUpgrade, connectionRegistry, isOriginAllowed, activeWriters } from "./proxy.js";
import { KeepAliveManager } from "./keepalive.js";
import { closePool } from "./db.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOSTNAME = process.env.BIND_HOST || "0.0.0.0";

let keepAliveManager: KeepAliveManager | null = null;

const coderUrl = process.env.CODER_URL ?? process.env.CODER_AGENT_URL ?? "";
const sessionToken = process.env.CODER_SESSION_TOKEN ?? "";

if (coderUrl && sessionToken) {
  keepAliveManager = new KeepAliveManager(connectionRegistry, coderUrl, sessionToken);
  keepAliveManager.start();
} else {
  console.warn("[keep-alive] CODER_URL or CODER_SESSION_TOKEN not set — keep-alive disabled");
}

function setCorsHeaders(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): boolean {
  const origin = req.headers.origin as string | undefined;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

const server = createServer((req, res) => {
  if (setCorsHeaders(req, res)) return;

  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url === "/keepalive/status") {
    const workspaces = keepAliveManager?.getHealth() ?? {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ workspaces }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket, head) => {
  const pathname = req.url?.split("?")[0] ?? "";
  if (pathname === "/ws") {
    handleUpgrade(req, socket, head);
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

if (!process.env.DATABASE_URL) {
  console.warn("[terminal-proxy] DATABASE_URL not set — scrollback persistence disabled");
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string) {
  console.log(`[terminal-proxy] ${signal} received — flushing scrollback writers`);
  const timeout = setTimeout(() => {
    console.error("[terminal-proxy] shutdown timeout — force exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    const closePromises = Array.from(activeWriters.values()).map((w) =>
      w.close().catch((err) => console.error("[scrollback] writer close error during shutdown:", (err as Error).message)),
    );
    await Promise.all(closePromises);
    activeWriters.clear();
    await closePool();
  } catch (err) {
    console.error("[terminal-proxy] shutdown error:", (err as Error).message);
  } finally {
    clearTimeout(timeout);
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

server.listen(PORT, HOSTNAME, () => {
  console.log(`[terminal-proxy] listening on http://${HOSTNAME}:${PORT}`);
});
