import { createHash } from "node:crypto";
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
import { type TerminalSessionEventStore, terminalSessionEventStore } from "./session-events.js";

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
type AuthorizedRequestResult = { workspaceIds: Set<string> };

const WORKSPACE_AUTHORIZATION_CACHE_TTL_MS = 5_000;
const WORKSPACE_AUTHORIZATION_CACHE_MAX_ENTRIES = 500;

interface TerminalProxyServerOptions {
  keepAliveManager?: KeepAliveStatusSource;
  sessionEventStore?: TerminalSessionEventStore;
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
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 405) return "Method Not Allowed";
  return "Bad Gateway";
}

function authorizationCacheKey(auth: AuthSuccess): string {
  return createHash("sha256")
    .update(auth.coderUrl ?? "")
    .update("\0")
    .update(auth.token)
    .digest("hex");
}

function createCachedAuthorizedWorkspaceResolver(
  resolveWorkspaceIds: AuthorizedWorkspaceResolver,
  now: () => number = Date.now,
): AuthorizedWorkspaceResolver {
  const cache = new Map<string, { expiresAt: number; value: Promise<Set<string>> }>();

  return async (auth) => {
    const currentTime = now();
    const key = authorizationCacheKey(auth);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > currentTime) return cached.value;
    if (cached) cache.delete(key);

    if (cache.size >= WORKSPACE_AUTHORIZATION_CACHE_MAX_ENTRIES) {
      for (const [cachedKey, entry] of cache) {
        if (
          entry.expiresAt <= currentTime ||
          cache.size >= WORKSPACE_AUTHORIZATION_CACHE_MAX_ENTRIES
        ) {
          cache.delete(cachedKey);
        }
      }
    }

    const value = resolveWorkspaceIds(auth).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { expiresAt: currentTime + WORKSPACE_AUTHORIZATION_CACHE_TTL_MS, value });
    return value;
  };
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
  const authorization = await authorizeReadRequest(
    req,
    res,
    authenticateStatus,
    resolveWorkspaceIds,
    "Workspace status unavailable",
  );
  if (!authorization) return;

  const filteredHealth = filterHealthByWorkspaceIds(
    keepAliveManager.getHealth(),
    authorization.workspaceIds,
  );
  writeJson(res, 200, serializeKeepAliveStatusPayload(filteredHealth));
}

async function authorizeReadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authenticateStatus: StatusAuthenticator,
  resolveWorkspaceIds: AuthorizedWorkspaceResolver,
  unavailableMessage: string,
): Promise<AuthorizedRequestResult | null> {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return null;
  }

  const authResult = await authenticateStatus(req);
  if (!authResult.ok) {
    const { status } = authResult.value;
    writeJson(res, status, { error: responseStatusText(status) });
    return null;
  }

  try {
    return {
      workspaceIds: await resolveWorkspaceIds(authResult.value),
    };
  } catch {
    writeJson(res, 502, { error: unavailableMessage });
    return null;
  }
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function handleSessionEventsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  eventStore: TerminalSessionEventStore,
  authenticateStatus: StatusAuthenticator,
  resolveWorkspaceIds: AuthorizedWorkspaceResolver,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/session-events", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    writeJson(res, 400, { error: "Bad Request" });
    return;
  }

  const authorization = await authorizeReadRequest(
    req,
    res,
    authenticateStatus,
    resolveWorkspaceIds,
    "Workspace session events unavailable",
  );
  if (!authorization) return;

  const workspaceId = url.searchParams.get("workspaceId");
  if (workspaceId && !authorization.workspaceIds.has(workspaceId)) {
    writeJson(res, 404, { error: "Workspace session events unavailable" });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  writeJson(
    res,
    200,
    eventStore.list({
      authorizedWorkspaceIds: authorization.workspaceIds,
      workspaceId,
      sessionName: url.searchParams.get("sessionName"),
      afterId: parsePositiveInteger(url.searchParams.get("after")),
      limit: parsePositiveInteger(url.searchParams.get("limit")),
    }),
  );
}

function logHttpFallbackFailure(): void {
  console.error("[terminal-proxy] event=http_request_failed category=unexpected_request_error");
}

function writeHttpFallbackResponse(res: ServerResponse): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    writeJson(res, 500, { error: "Internal Server Error" });
    return;
  }
  res.end();
}

async function routeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  keepAliveManager: KeepAliveStatusSource,
  eventStore: TerminalSessionEventStore,
  authenticateStatus: StatusAuthenticator,
  resolveWorkspaceIds: AuthorizedWorkspaceResolver,
): Promise<void> {
  if (setCorsHeaders(req, res)) return;

  if (req.url === "/healthz") {
    writeJson(res, 200, { status: "ok" });
    return;
  }

  const pathname = req.url?.split("?")[0] ?? "";
  if (pathname === "/keepalive/status") {
    await handleKeepAliveStatusRequest(
      req,
      res,
      keepAliveManager,
      authenticateStatus,
      resolveWorkspaceIds,
    );
    return;
  }

  if (pathname === "/session-events") {
    await handleSessionEventsRequest(req, res, eventStore, authenticateStatus, resolveWorkspaceIds);
    return;
  }

  res.writeHead(404);
  res.end();
}

function attachUpgradeRouting(
  server: ReturnType<typeof createServer>,
  upgradeHandler: UpgradeHandler,
) {
  server.on("upgrade", (req, socket, head) => {
    const pathname = req.url?.split("?")[0] ?? "";
    if (pathname === "/ws") {
      upgradeHandler(req, socket, head).catch(() => {
        logUpgradeFallbackFailure();
        writeUpgradeFallbackResponse(socket);
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });
}

function resolveUpgradeHandler(
  configuredHandler: UpgradeHandler | undefined,
  eventStore: TerminalSessionEventStore,
): UpgradeHandler {
  if (configuredHandler) return configuredHandler;
  return (req, socket, head) => handleUpgrade(req, socket, head, eventStore);
}

function resolveServerAuthorization(
  configuredAuthenticator: StatusAuthenticator | undefined,
  configuredResolver: AuthorizedWorkspaceResolver | undefined,
) {
  return {
    authenticateStatus: configuredAuthenticator ?? authenticateUpgrade,
    resolveWorkspaceIds: createCachedAuthorizedWorkspaceResolver(
      configuredResolver ?? resolveAuthorizedWorkspaceIds,
    ),
  };
}

export function createTerminalProxyServer(options: TerminalProxyServerOptions = {}) {
  const keepAliveManager = options.keepAliveManager ?? createDefaultKeepAliveManager();
  const eventStore = options.sessionEventStore ?? terminalSessionEventStore;
  const upgradeHandler = resolveUpgradeHandler(options.upgradeHandler, eventStore);
  const { authenticateStatus, resolveWorkspaceIds } = resolveServerAuthorization(
    options.statusAuthenticator,
    options.authorizedWorkspaceResolver,
  );

  keepAliveManager.start();

  const server = createServer((req, res) => {
    routeHttpRequest(
      req,
      res,
      keepAliveManager,
      eventStore,
      authenticateStatus,
      resolveWorkspaceIds,
    ).catch(() => {
      logHttpFallbackFailure();
      writeHttpFallbackResponse(res);
    });
  });
  attachUpgradeRouting(server, upgradeHandler);

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
