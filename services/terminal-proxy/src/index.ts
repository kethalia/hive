import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

import { createServer } from "node:http";
import { handleUpgrade, connectionRegistry, isOriginAllowed } from "./proxy.js";
import { KeepAliveManager } from "./keepalive.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOSTNAME = process.env.BIND_HOST || "0.0.0.0";

const coderUrl = process.env.CODER_URL ?? process.env.CODER_AGENT_URL ?? "";

const keepAliveManager = new KeepAliveManager(connectionRegistry, coderUrl);
keepAliveManager.start();

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
    const raw = keepAliveManager?.getHealth() ?? {};
    const workspaces: Record<string, { consecutiveFailures: number; lastSuccess: string | null; lastFailure: string | null }> = {};
    for (const [id, health] of Object.entries(raw)) {
      workspaces[id] = {
        consecutiveFailures: health.consecutiveFailures,
        lastSuccess: health.lastSuccess,
        lastFailure: health.lastFailure,
      };
    }
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
    void handleUpgrade(req, socket, head);
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`[terminal-proxy] listening on http://${HOSTNAME}:${PORT}`);
});
