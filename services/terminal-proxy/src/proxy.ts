import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { verifyCloneTerminalProof } from "@hive/auth";
import { WebSocket, WebSocketServer } from "ws";
import { authenticateUpgrade } from "./auth.js";
import { getCoderCaCertificates } from "./coder-fetch.js";
import { ConnectionRegistry } from "./keepalive.js";
import { buildPtyUrl, SAFE_IDENTIFIER_RE, UUID_RE } from "./protocol.js";

const PING_INTERVAL_MS = 15_000;
const MAX_MISSED_HEARTBEATS = 2;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const BROWSER_CLOSE_UPSTREAM_CLOSED_CODE = 1013;
const BROWSER_CLOSE_UPSTREAM_CLOSED_REASON = "upstream closed";
const BROWSER_CLOSE_UPSTREAM_ERROR_CODE = 1011;
const BROWSER_CLOSE_UPSTREAM_ERROR_REASON = "upstream error";
const BROWSER_CLOSE_UPSTREAM_TIMEOUT_CODE = 1013;
const BROWSER_CLOSE_UPSTREAM_TIMEOUT_REASON = "upstream connect timeout";
const CLONE_TERMINAL_SESSION_PREFIX = "git-clone-";
const CLONE_TERMINAL_SESSION_RE = /^git-clone-[0-9a-f]{32}$/;
const PROJECTS_ROOT_ENV_KEY = "HIVE_PROJECTS_ROOT";
const DEFAULT_PROJECTS_ROOT_PATH = "/home/coder";

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
    cachedOrigins = env
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
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

type CloneCwdValidationResult =
  | {
      ok: true;
      cwd?: string;
      cloneProof?: string;
      proofExpectation?: CloneProofExpectation;
    }
  | { ok: false; reason: string; status?: 400 | 401 | 502 };

type CloneProofExpectation = {
  workspaceId: string | null;
  agentId: string;
  sessionId?: string;
  sessionName: string;
  clonePath: string;
};

function resolveProjectsRoot(): string {
  const configuredRoot = process.env[PROJECTS_ROOT_ENV_KEY]?.trim();
  if (!configuredRoot) return DEFAULT_PROJECTS_ROOT_PATH;

  if (!isAbsolutePosixPath(configuredRoot)) {
    throw new Error(`${PROJECTS_ROOT_ENV_KEY} must be an absolute POSIX path`);
  }

  return normalizeAbsolutePosixPath(configuredRoot);
}

function isAbsolutePosixPath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\\") && !value.includes("\0");
}

function normalizeAbsolutePosixPath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized !== "/" && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function createCanonicalCloneSessionName(pathSegments: readonly string[]): string {
  const cloneSessionKey = `git-clone:${pathSegments.map(encodeURIComponent).join("/")}`;
  const digest = createHash("sha256").update(cloneSessionKey).digest("hex").slice(0, 32);
  return `${CLONE_TERMINAL_SESSION_PREFIX}${digest}`;
}

function validateClonePathSegments(
  clonePath: string,
): { ok: true; pathSegments: string[] } | { ok: false; reason: string } {
  if (clonePath.length === 0) {
    return { ok: false, reason: "clonePath_empty" };
  }

  if (clonePath.includes("\0")) {
    return { ok: false, reason: "clonePath_nul" };
  }

  if (clonePath.includes("\\") || /^[a-zA-Z]:[\\/]/.test(clonePath)) {
    return { ok: false, reason: "clonePath_malformed" };
  }

  if (path.isAbsolute(clonePath)) {
    return { ok: false, reason: "clonePath_absolute" };
  }

  const pathSegments = clonePath.split("/");

  if (pathSegments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: "clonePath_empty_segment" };
  }

  if (pathSegments.length === 1 && pathSegments[0] === ".") {
    return { ok: false, reason: "clonePath_root" };
  }

  if (pathSegments.some((segment) => segment === ".")) {
    return { ok: false, reason: "clonePath_dot_segment" };
  }

  if (pathSegments.some((segment) => segment === "..")) {
    return { ok: false, reason: "clonePath_traversal" };
  }

  return { ok: true, pathSegments };
}

function logPreAuthRejection(reason: string): void {
  console.error(`[terminal-proxy] upgrade rejected before auth: ${reason}`);
}

function logPostAuthRejection(reason: string): void {
  console.error(`[terminal-proxy] upgrade rejected after auth: ${reason}`);
}

function logProxyEvent(
  level: "error" | "log",
  event: string,
  fields: Record<string, string | number> = {},
): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const message = suffix
    ? `[terminal-proxy] event=${event} ${suffix}`
    : `[terminal-proxy] event=${event}`;
  console[level](message);
}

function getCloneTerminalProofSecret(): string | null {
  return process.env.COOKIE_SECRET?.trim() || null;
}

function validateCloneProof(
  cloneProof: string | null,
  expected: CloneProofExpectation,
): CloneCwdValidationResult {
  if (!expected.workspaceId) {
    return { ok: false, reason: "workspaceId_required_for_clone_session" };
  }

  const secret = getCloneTerminalProofSecret();
  if (!secret) {
    return { ok: false, reason: "cloneProof_secret_missing", status: 502 };
  }

  try {
    const result = verifyCloneTerminalProof(
      cloneProof,
      {
        workspaceId: expected.workspaceId,
        agentId: expected.agentId,
        sessionId: expected.sessionId,
        sessionName: expected.sessionName,
        clonePath: expected.clonePath,
      },
      secret,
    );

    if (!result.ok) {
      return { ok: false, reason: `cloneProof_${result.reason}` };
    }
  } catch {
    return { ok: false, reason: "cloneProof_malformed" };
  }

  return { ok: true };
}

async function validateCloneCwd(
  sessionName: string,
  clonePath: string | null,
  cloneProof: string | null,
  proofExpectation: Omit<CloneProofExpectation, "sessionName" | "clonePath">,
): Promise<CloneCwdValidationResult> {
  const usesCloneSessionPrefix = sessionName.startsWith(CLONE_TERMINAL_SESSION_PREFIX);

  if (!usesCloneSessionPrefix) {
    if (clonePath !== null) {
      return { ok: false, reason: "clonePath_not_allowed_for_non_clone_session" };
    }
    if (cloneProof !== null) {
      return { ok: false, reason: "cloneProof_not_allowed_for_non_clone_session" };
    }
    return { ok: true };
  }

  if (!CLONE_TERMINAL_SESSION_RE.test(sessionName)) {
    return { ok: false, reason: "clone_session_malformed" };
  }

  if (clonePath === null) {
    return { ok: false, reason: "clonePath_required_for_clone_session" };
  }

  const clonePathSegments = validateClonePathSegments(clonePath);
  if (!clonePathSegments.ok) {
    return clonePathSegments;
  }

  const expectedSessionName = createCanonicalCloneSessionName(clonePathSegments.pathSegments);
  if (sessionName !== expectedSessionName) {
    return { ok: false, reason: "clone_session_mismatch" };
  }

  const proofExpectationWithPath = {
    ...proofExpectation,
    sessionName,
    clonePath,
  };
  const cloneProofValidation = validateCloneProof(cloneProof, proofExpectationWithPath);
  if (!cloneProofValidation.ok) {
    return cloneProofValidation;
  }

  let projectsRoot: string;
  try {
    projectsRoot = resolveProjectsRoot();
  } catch {
    return { ok: false, reason: "projectsRoot_invalid", status: 502 };
  }

  const cwd = path.resolve(projectsRoot, ...clonePathSegments.pathSegments);
  const projectsRootPrefix = projectsRoot.endsWith(path.sep)
    ? projectsRoot
    : `${projectsRoot}${path.sep}`;

  if (cwd === projectsRoot) {
    return { ok: false, reason: "clonePath_root" };
  }

  if (!cwd.startsWith(projectsRootPrefix)) {
    return { ok: false, reason: "clonePath_escape" };
  }

  return {
    ok: true,
    cwd,
    cloneProof: cloneProof ?? undefined,
    proofExpectation: proofExpectationWithPath,
  };
}

export async function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const origin = req.headers.origin as string | undefined;
  if (!isOriginAllowed(origin)) {
    logPreAuthRejection("origin_rejected");
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const agentId = url.searchParams.get("agentId");
  const reconnectId = url.searchParams.get("reconnectId");
  const workspaceId = url.searchParams.get("workspaceId");

  if (workspaceId && !UUID_RE.test(workspaceId)) {
    logPreAuthRejection("workspaceId_invalid_format");
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const width = url.searchParams.get("width");
  const height = url.searchParams.get("height");
  const sessionName = url.searchParams.get("sessionName") ?? "default";
  const clonePath = url.searchParams.get("clonePath");
  const cloneProof = url.searchParams.get("cloneProof");

  if (!agentId || !reconnectId) {
    logPreAuthRejection("required_params_missing");
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!UUID_RE.test(agentId)) {
    logPreAuthRejection("agentId_invalid_format");
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!UUID_RE.test(reconnectId)) {
    logPreAuthRejection("reconnectId_invalid_format");
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!SAFE_IDENTIFIER_RE.test(sessionName)) {
    logPreAuthRejection("sessionName_unsafe");
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const cloneCwd = await validateCloneCwd(sessionName, clonePath, cloneProof, {
    workspaceId,
    agentId,
  });
  if (!cloneCwd.ok) {
    logPreAuthRejection(cloneCwd.reason);
    const statusLine = cloneCwd.status === 502 ? "502 Bad Gateway" : "400 Bad Request";
    socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
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

  const { token, coderUrl: authCoderUrl, sessionId } = authResult.value;

  if (sessionName.startsWith(CLONE_TERMINAL_SESSION_PREFIX)) {
    if (!sessionId) {
      logPostAuthRejection("cloneProof_mismatch");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionProofValidation = validateCloneProof(cloneProof, {
      workspaceId,
      agentId,
      sessionId,
      sessionName,
      clonePath: clonePath ?? "",
    });
    if (!sessionProofValidation.ok) {
      logPostAuthRejection(sessionProofValidation.reason);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }

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
    cwd: cloneCwd.cwd,
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

    connectUpstream(browserWs, upstreamUrl, token);
  });
}

function connectUpstream(browserWs: WebSocket, upstreamUrl: string, token: string): void {
  logProxyEvent("log", "upstream_connecting", { category: "upstream_connecting" });
  const ca = getCoderCaCertificates();

  const upstream = new WebSocket(upstreamUrl, {
    headers: { "Coder-Session-Token": token },
    handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
    ...(ca ? { ca } : {}),
  });

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let browserResponsive = true;
  let upstreamResponsive = true;
  let browserMissedHeartbeats = 0;
  let upstreamMissedHeartbeats = 0;

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
    logProxyEvent("log", "upstream_connected", { category: "upstream_connected" });
    const runHeartbeat = () => {
      browserMissedHeartbeats = browserResponsive ? 0 : browserMissedHeartbeats + 1;
      upstreamMissedHeartbeats = upstreamResponsive ? 0 : upstreamMissedHeartbeats + 1;

      if (
        browserMissedHeartbeats > MAX_MISSED_HEARTBEATS ||
        upstreamMissedHeartbeats > MAX_MISSED_HEARTBEATS
      ) {
        const unresponsiveLeg =
          browserMissedHeartbeats > MAX_MISSED_HEARTBEATS ? "browser" : "upstream";
        logProxyEvent("error", "heartbeat_timeout", {
          category: "heartbeat_timeout",
          leg: unresponsiveLeg,
        });
        if (
          browserMissedHeartbeats > MAX_MISSED_HEARTBEATS &&
          browserWs.readyState === WebSocket.OPEN
        ) {
          browserWs.terminate();
        }
        if (
          upstreamMissedHeartbeats > MAX_MISSED_HEARTBEATS &&
          upstream.readyState === WebSocket.OPEN
        ) {
          upstream.terminate();
        }
        cleanup();
        return;
      }

      browserResponsive = false;
      upstreamResponsive = false;
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.ping();
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.ping();
      }
    };
    runHeartbeat();
    pingTimer = setInterval(runHeartbeat, PING_INTERVAL_MS);
  });

  browserWs.on("pong", () => {
    browserResponsive = true;
  });

  upstream.on("pong", () => {
    upstreamResponsive = true;
  });

  upstream.on("message", (data, isBinary) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(data, { binary: isBinary });
    }
  });

  upstream.on("error", () => {
    logProxyEvent("error", "upstream_error", { category: "upstream_error" });
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.close(BROWSER_CLOSE_UPSTREAM_ERROR_CODE, BROWSER_CLOSE_UPSTREAM_ERROR_REASON);
    }
    cleanup();
  });

  upstream.on("close", (code) => {
    logProxyEvent("log", "upstream_closed", { category: "upstream_closed", code });
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.close(BROWSER_CLOSE_UPSTREAM_CLOSED_CODE, BROWSER_CLOSE_UPSTREAM_CLOSED_REASON);
    }
    cleanup();
  });

  browserWs.on("message", (data) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    }
  });

  browserWs.on("close", () => {
    logProxyEvent("log", "browser_disconnected", { category: "browser_disconnected" });
    cleanup();
  });

  browserWs.on("error", () => {
    logProxyEvent("error", "browser_error", { category: "browser_error" });
    cleanup();
  });

  setTimeout(() => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      logProxyEvent("error", "upstream_connect_timeout", {
        category: "upstream_connect_timeout",
      });
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close(BROWSER_CLOSE_UPSTREAM_TIMEOUT_CODE, BROWSER_CLOSE_UPSTREAM_TIMEOUT_REASON);
      }
      cleanup();
    }
  }, UPSTREAM_CONNECT_TIMEOUT_MS);
}
