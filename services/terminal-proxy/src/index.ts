import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { type AuthResult, type AuthSuccess, authenticateUpgrade } from "./auth.js";
import { fetchCoderApi } from "./coder-fetch.js";
import {
  KeepAliveManager,
  serializeKeepAliveStatusPayload,
  type WorkspaceHealth,
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
type StatusAuthenticator = (req: IncomingMessage) => Promise<AuthResult>;
type AuthorizedWorkspaceResolver = (auth: AuthSuccess) => Promise<Set<string>>;

interface TerminalProxyServerOptions {
  keepAliveManager?: KeepAliveStatusSource;
  upgradeHandler?: UpgradeHandler;
  statusAuthenticator?: StatusAuthenticator;
  authorizedWorkspaceResolver?: AuthorizedWorkspaceResolver;
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
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function responseStatusText(status: number): string {
  if (status === 401) return "Unauthorized";
  if (status === 405) return "Method Not Allowed";
  return "Bad Gateway";
}

async function resolveAuthorizedWorkspaceIds(auth: AuthSuccess): Promise<Set<string>> {
  const coderUrl = (
    auth.coderUrl ||
    process.env.CODER_URL ||
    process.env.CODER_AGENT_URL ||
    ""
  ).replace(/\/+$/, "");
  if (!coderUrl) throw new Error("coder_url_missing");

  const res = await fetchCoderApi(
    `${coderUrl}/api/v2/workspaces?q=${encodeURIComponent("owner:me")}`,
    {
      headers: {
        "Content-Type": "application/json",
        "Coder-Session-Token": auth.token,
      },
    },
  );
  if (!res.ok) throw new Error(`coder_workspaces_unavailable:${res.status}`);

  const payload: unknown = await res.json();
  const workspaces =
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { workspaces?: unknown }).workspaces)
      ? (payload as { workspaces: unknown[] }).workspaces
      : [];

  return new Set(
    workspaces
      .map((workspace) =>
        typeof workspace === "object" && workspace !== null
          ? (workspace as { id?: unknown }).id
          : null,
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

function filterHealthByWorkspaceIds(
  health: Record<string, WorkspaceHealth>,
  authorizedWorkspaceIds: Set<string>,
): Record<string, WorkspaceHealth> {
  const filtered: Record<string, WorkspaceHealth> = {};
  for (const [workspaceId, workspaceHealth] of Object.entries(health)) {
    if (authorizedWorkspaceIds.has(workspaceId)) filtered[workspaceId] = workspaceHealth;
  }
  return filtered;
}

async function handleKeepAliveStatusRequest(
  req: IncomingMessage,
  res: ServerResponse,
  keepAliveManager: KeepAliveStatusSource,
  authenticateStatus: StatusAuthenticator,
  resolveWorkspaceIds: AuthorizedWorkspaceResolver,
): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const authResult = await authenticateStatus(req);
  if (!authResult.ok) {
    const { status } = authResult.value;
    writeJson(res, status, { error: responseStatusText(status) });
    return;
  }

  let authorizedWorkspaceIds: Set<string>;
  try {
    authorizedWorkspaceIds = await resolveWorkspaceIds(authResult.value);
  } catch {
    writeJson(res, 502, { error: "Workspace status unavailable" });
    return;
  }

  const filteredHealth = filterHealthByWorkspaceIds(
    keepAliveManager.getHealth(),
    authorizedWorkspaceIds,
  );
  writeJson(res, 200, serializeKeepAliveStatusPayload(filteredHealth));
}

export function createTerminalProxyServer(options: TerminalProxyServerOptions = {}) {
  const keepAliveManager = options.keepAliveManager ?? createDefaultKeepAliveManager();
  const upgradeHandler = options.upgradeHandler ?? handleUpgrade;
  const authenticateStatus = options.statusAuthenticator ?? authenticateUpgrade;
  const resolveWorkspaceIds = options.authorizedWorkspaceResolver ?? resolveAuthorizedWorkspaceIds;

  keepAliveManager.start();

  const server = createServer((req, res) => {
    if (setCorsHeaders(req, res)) return;

    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if ((req.url?.split("?")[0] ?? "") === "/keepalive/status") {
      void handleKeepAliveStatusRequest(
        req,
        res,
        keepAliveManager,
        authenticateStatus,
        resolveWorkspaceIds,
      );
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
