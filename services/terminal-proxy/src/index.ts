import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import {
  KeepAliveManager,
  type WorkspaceHealth,
  serializeKeepAliveStatusPayload,
} from "./keepalive.js";
import { connectionRegistry, handleUpgrade, isOriginAllowed } from "./proxy.js";

const INDEX_FILE = fileURLToPath(import.meta.url);

config({ path: resolve(dirname(INDEX_FILE), "../../../.env") });

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOSTNAME = process.env.BIND_HOST || "0.0.0.0";

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
type KeepAliveStatusSource = {
  start(): void;
  stop(): void;
  getHealth(): Record<string, WorkspaceHealth>;
};

interface TerminalProxyServerOptions {
  keepAliveManager?: KeepAliveStatusSource;
  upgradeHandler?: UpgradeHandler;
}

function createDefaultKeepAliveManager(): KeepAliveManager {
  const coderUrl = process.env.CODER_URL ?? process.env.CODER_AGENT_URL ?? "";
  return new KeepAliveManager(connectionRegistry, coderUrl);
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
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

function logUpgradeFallbackFailure(): void {
  console.error("[terminal-proxy] event=upgrade_failed category=unexpected_upgrade_error");
}

function writeUpgradeFallbackResponse(socket: Duplex): void {
  if (socket.writable) {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
  }
}

export function createTerminalProxyServer(options: TerminalProxyServerOptions = {}) {
  const keepAliveManager = options.keepAliveManager ?? createDefaultKeepAliveManager();
  const upgradeHandler = options.upgradeHandler ?? handleUpgrade;

  keepAliveManager.start();

  const server = createServer((req, res) => {
    if (setCorsHeaders(req, res)) return;

    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.url === "/keepalive/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(serializeKeepAliveStatusPayload(keepAliveManager.getHealth())));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url?.split("?")[0] ?? "";
    if (pathname === "/ws") {
      upgradeHandler(req, socket, head).catch(() => {
        logUpgradeFallbackFailure();
        writeUpgradeFallbackResponse(socket);
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  server.on("close", () => {
    keepAliveManager.stop();
  });

  return { server, keepAliveManager };
}

const isEntrypoint = process.argv[1] ? INDEX_FILE === resolve(process.argv[1]) : false;

if (isEntrypoint) {
  const { server } = createTerminalProxyServer();
  server.listen(PORT, HOSTNAME, () => {
    console.log(`[terminal-proxy] listening on http://${HOSTNAME}:${PORT}`);
  });
}
