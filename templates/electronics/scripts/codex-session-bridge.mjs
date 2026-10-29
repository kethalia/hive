#!/usr/bin/env node
// Explicit opt-in prototype; never launches Codex or creates a native thread.
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const VERSION = "0.165.0";
const MAX_FRAME = 1024 * 1024;
const MAX_REQUESTS = 256;
const MAX_NONCES = 4096;
const BINDING_KEYS = ["ownerId", "workspaceId", "buildId", "serverInstanceId", "threadId"];
const own = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
function check(condition, message = "Invalid bridge input") {
  if (!condition) throw new Error(message);
}
function origin(value) {
  const url = new URL(value);
  check(
    url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.hostname.includes("*"),
    "Expected an exact HTTPS origin",
  );
  return value;
}
function privatePath(path, directory = false) {
  check(isAbsolute(path), "Private paths must be absolute");
  const stat = lstatSync(path);
  check(
    !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()),
    "Invalid private path",
  );
  check(
    stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
    "Private path must be owned by this user and inaccessible to others",
  );
}

export function validateConfig(raw, registeredHost = false) {
  check(
    own(raw, [
      "schemaVersion",
      "protocolVersion",
      "binding",
      "hiveOrigin",
      "appOrigin",
      "nativeUrl",
      "publicKeyPem",
      "keyId",
      "stateDirectory",
      "port",
    ]),
  );
  check(
    raw.schemaVersion === 1 && raw.protocolVersion === VERSION,
    "Unsupported Codex protocol version",
  );
  check(
    own(raw.binding, registeredHost ? BINDING_KEYS.slice(0, -1) : BINDING_KEYS) &&
      (registeredHost ? BINDING_KEYS.slice(0, -1) : BINDING_KEYS).every((key) =>
        identifier(raw.binding[key]),
      ),
    "Invalid independently configured host binding",
  );
  if (registeredHost)
    check(raw.nativeUrl === undefined, "Registered native endpoint is host-owned");
  else {
    const native = new URL(raw.nativeUrl);
    check(
      native.protocol === "ws:" &&
        native.hostname === "127.0.0.1" &&
        native.port &&
        native.pathname === "/" &&
        !native.username &&
        !native.password &&
        !native.search &&
        !native.hash,
      "Native endpoint must be a pinned loopback WebSocket",
    );
  }
  check(identifier(raw.keyId) && Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535);
  privatePath(raw.stateDirectory, true);
  check(
    typeof raw.publicKeyPem === "string" &&
      raw.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----") &&
      raw.publicKeyPem.length <= 8192,
    "Provide only a pinned public key",
  );
  const key = createPublicKey(raw.publicKeyPem);
  check(
    key.asymmetricKeyType === "ed25519",
    "Only an explicitly pinned Ed25519 public key is supported",
  );
  check(
    new URL(raw.hiveOrigin).hostname !== new URL(raw.appOrigin).hostname,
    "The app must have an isolated hostname",
  );
  return Object.freeze({
    ...raw,
    binding: Object.freeze({ ...raw.binding }),
    hiveOrigin: origin(raw.hiveOrigin),
    appOrigin: origin(raw.appOrigin),
    key,
  });
}

function createTicketVerifier(config, authorizeBinding) {
  const digest = createHash("sha256")
    .update(JSON.stringify(BINDING_KEYS.map((key) => config.binding[key])))
    .digest("hex");
  const path = join(config.stateDirectory, `codex-session-replay-${digest}.json`);
  // Keep this inode: deleting lock files can create two independently locked inodes.
  // flock's child fd3 shares Node's open file description. The child exits after
  // acquisition; this retained descriptor keeps the kernel lock until close/crash.
  const lockHandle = openSync(
    `${path}.lock`,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let nonces = new Map();
  try {
    const lockStat = fstatSync(lockHandle);
    check(
      lockStat.isFile() && lockStat.uid === process.getuid() && (lockStat.mode & 0o077) === 0,
      "Invalid private replay lock",
    );
    try {
      execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", lockHandle],
        timeout: 2000,
        env: { PATH: "/usr/bin:/bin" },
      });
    } catch {
      throw new Error("Replay state lock unavailable");
    }
    // Read only after acquiring exclusivity, including during crash recovery.
    try {
      privatePath(path);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      check(
        Array.isArray(saved) &&
          saved.length <= MAX_NONCES &&
          saved.every(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              identifier(entry[0]) &&
              Number.isSafeInteger(entry[1]),
          ),
        "Invalid replay state",
      );
      nonces = new Map(saved);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } catch (error) {
    closeSync(lockHandle);
    throw error;
  }
  const accept = (ticket) => {
    check(typeof ticket === "string" && ticket.length <= 8192, "Invalid ticket");
    const parts = ticket.split(".");
    check(
      parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)),
      "Invalid ticket encoding",
    );
    const header = JSON.parse(Buffer.from(parts[0], "base64url"));
    check(
      own(header, ["alg", "typ", "kid"]) &&
        header.alg === "EdDSA" &&
        header.typ === "JWT" &&
        header.kid === config.keyId,
      "Unsupported ticket header",
    );
    check(
      verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        config.key,
        Buffer.from(parts[2], "base64url"),
      ),
      "Invalid ticket signature",
    );
    const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    check(
      own(claims, [
        "iss",
        "aud",
        "sub",
        "workspaceId",
        "buildId",
        "serverInstanceId",
        "threadId",
        "origin",
        "scope",
        "iat",
        "exp",
        "jti",
      ]),
    );
    check(
      claims.iss === config.hiveOrigin &&
        claims.aud === config.appOrigin &&
        claims.origin === config.hiveOrigin &&
        claims.scope === "session:read",
      "Ticket scope or origin mismatch",
    );
    check(
      claims.sub === config.binding.ownerId &&
        BINDING_KEYS.filter((key) => key !== "ownerId" && Object.hasOwn(config.binding, key)).every(
          (key) => claims[key] === config.binding[key],
        ),
      "Ticket host binding mismatch",
    );
    check(identifier(claims.threadId), "Invalid ticket thread binding");
    authorizeBinding?.({
      ownerId: claims.sub,
      workspaceId: claims.workspaceId,
      buildId: claims.buildId,
      serverInstanceId: claims.serverInstanceId,
      threadId: claims.threadId,
    });
    const now = Date.now() / 1000;
    check(
      Number.isSafeInteger(claims.iat) &&
        Number.isSafeInteger(claims.exp) &&
        claims.iat <= now &&
        claims.exp > now &&
        claims.exp - claims.iat > 0 &&
        claims.exp - claims.iat <= 60,
      "Ticket expired or exceeds 60 seconds",
    );
    check(identifier(claims.jti) && claims.jti.length >= 16, "Invalid ticket nonce");
    for (const [nonce, expiry] of nonces) if (expiry <= now) nonces.delete(nonce);
    check(
      !nonces.has(claims.jti) && nonces.size < MAX_NONCES,
      "Ticket replay or replay cache full",
    );
    nonces.set(claims.jti, claims.exp);
    // Persist before accepting: restarting the gateway must not enable ticket reuse.
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify([...nonces]), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    return claims;
  };
  return {
    accept,
    close: () => {
      closeSync(lockHandle);
    },
  };
}

function displayItem(item) {
  check(item && identifier(item.id) && typeof item.type === "string");
  const base = { id: item.id, type: item.type };
  if (item.type === "agentMessage" || item.type === "plan") {
    check(typeof item.text === "string");
    return { ...base, text: item.text };
  }
  if (item.type === "userMessage") {
    check(Array.isArray(item.content));
    return {
      ...base,
      content: item.content.map((value) =>
        value.type === "text" ? { type: "text", text: value.text } : { type: value.type },
      ),
    };
  }
  if (item.type === "commandExecution")
    return {
      ...base,
      command: item.command,
      aggregatedOutput: item.aggregatedOutput,
      status: item.status,
      exitCode: item.exitCode,
    };
  // Never forward reasoning internals, tool arguments, or unsupported item payloads.
  return base;
}
function displayTurn(turn) {
  check(turn && identifier(turn.id) && Array.isArray(turn.items) && turn.items.length <= 1000);
  return {
    id: turn.id,
    status: turn.status,
    itemsView: turn.itemsView,
    items: turn.items.map(displayItem),
  };
}
function projectEvent(message, threadId) {
  if (!message.params || message.params.threadId !== threadId) return null;
  if (message.id !== undefined)
    return { method: "hive/session/actionRequired", params: { threadId } };
  const { method, params } = message;
  if (["turn/started", "turn/completed"].includes(method))
    return { method, params: { threadId, turn: displayTurn(params.turn) } };
  if (["item/started", "item/completed"].includes(method))
    return { method, params: { threadId, turnId: params.turnId, item: displayItem(params.item) } };
  if (["item/agentMessage/delta", "item/commandExecution/outputDelta"].includes(method))
    return {
      method,
      params: { threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta },
    };
  if (["thread/reverted", "thread/closed", "thread/archived", "thread/deleted"].includes(method))
    return { method, params: { threadId } };
  return null;
}

function connectNative(config, emit, closed, createNativeSocket) {
  const socket = createNativeSocket
    ? createNativeSocket()
    : new WebSocket(config.nativeUrl, {
        maxPayload: MAX_FRAME,
        handshakeTimeout: 5000,
        followRedirects: false,
        perMessageDeflate: false,
      });
  const pending = new Map();
  let sequence = 0;
  socket.on("error", () => {
    socket.terminate();
  });
  socket.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Native connection closed"));
    }
    pending.clear();
    closed();
  });
  socket.on("message", (data, binary) => {
    try {
      check(!binary);
      const message = JSON.parse(data);
      const entry = pending.get(message.id);
      if (entry && ("result" in message || "error" in message)) {
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error)
          entry.reject(
            Object.assign(new Error("Native request rejected"), {
              code: message.error.code,
              missing: String(message.error.message).includes("no rollout found for thread id"),
            }),
          );
        else entry.resolve(message.result);
      } else {
        const event = projectEvent(message, config.binding.threadId);
        if (event) emit(event);
      }
    } catch {
      socket.terminate();
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const call = async (method, params) => {
    await ready;
    check(socket.readyState === WebSocket.OPEN);
    return new Promise((resolve, reject) => {
      const id = `bridge-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native request timed out"));
        socket.terminate();
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { call, socket, notify: (method) => socket.send(JSON.stringify({ method })) };
}

function validateRequest(message, threadId) {
  check(
    own(message, ["id", "method", "params"]) &&
      (identifier(message.id) || Number.isSafeInteger(message.id)),
    "Invalid RPC request",
  );
  const params = message.params;
  if (message.method === "initialize") {
    check(
      own(params, ["clientInfo"]) && own(params.clientInfo, ["name", "title", "version"]),
      "Unsupported initialize parameters",
    );
    return;
  }
  check(params?.threadId === threadId, "Thread binding mismatch");
  if (message.method === "thread/resume")
    check(
      own(params, ["threadId", "excludeTurns"]) && params.excludeTurns === true,
      "Resume overrides are not permitted",
    );
  else if (message.method === "thread/turns/list") {
    check(own(params, ["threadId", "cursor", "limit", "sortDirection", "itemsView"]));
    check(
      params.itemsView === "full" &&
        ["asc", "desc"].includes(params.sortDirection) &&
        Number.isSafeInteger(params.limit) &&
        params.limit >= 1 &&
        params.limit <= 100,
    );
    check(
      params.cursor === undefined ||
        (typeof params.cursor === "string" && params.cursor.length <= 4096),
    );
  } else throw new Error("RPC method is not allowed");
}

export async function startBridge(rawConfig, registeredHost) {
  if (registeredHost)
    check(
      typeof registeredHost.authorizeBinding === "function" &&
        typeof registeredHost.createNativeSocket === "function" &&
        typeof registeredHost.onRevoked === "function",
    );
  const config = validateConfig(rawConfig, Boolean(registeredHost));
  const verifier = createTicketVerifier(config, registeredHost?.authorizeBinding);
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (
      request.method === "POST" &&
      request.url === "/registration/bootstrap" &&
      registeredHost?.handleBootstrap
    ) {
      void registeredHost.handleBootstrap(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(403);
        response.end();
      });
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/projects/discover" &&
      registeredHost?.handleProjects
    ) {
      void registeredHost.handleProjects(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(403);
        response.end();
      });
      return;
    }
    response.writeHead(request.method === "GET" && request.url === "/healthz" ? 200 : 404);
    response.end();
  });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  const unsubscribe = registeredHost?.onRevoked(() => {
    for (const client of websocket.clients) client.close(1008, "Native lifetime revoked");
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/session" ||
      request.headers.origin !== config.hiveOrigin ||
      request.headers.host !== new URL(config.appOrigin).host ||
      websocket.clients.size >= 16
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) =>
      websocket.emit("connection", client),
    );
  });
  websocket.on("connection", (client) => {
    let authenticated = false;
    let authenticating = false;
    let initialized = false;
    let acknowledged = false;
    let resumed = false;
    let native;
    let nativeInfo;
    let inFlight = 0;
    let tokens = 32;
    let last = Date.now();
    const ids = new Set();
    let expiryTimer;
    let expiresAt = 0;
    let connectionBinding;
    const authorize = () => registeredHost?.authorizeBinding(connectionBinding);
    const authTimer = setTimeout(() => client.close(1008, "Authentication required"), 5000);
    const send = (message) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const encoded = JSON.stringify(message);
      if (Buffer.byteLength(encoded) > MAX_FRAME || client.bufferedAmount > 2 * MAX_FRAME) {
        client.close(1009, "Output limit exceeded");
        return;
      }
      client.send(encoded);
    };
    client.on("error", () => client.terminate());
    client.on("close", () => {
      clearTimeout(authTimer);
      clearTimeout(expiryTimer);
      native?.socket.terminate();
    });
    client.on("message", async (data, binary) => {
      try {
        check(!binary && data.length <= MAX_FRAME);
        const now = Date.now();
        tokens = Math.min(32, tokens + (now - last) * 0.016);
        last = now;
        check(tokens >= 1, "Rate limit exceeded");
        tokens--;
        const message = JSON.parse(data);
        if (!authenticated) {
          check(
            !authenticating && own(message, ["type", "ticket"]) && message.type === "authenticate",
          );
          authenticating = true;
          const claims = verifier.accept(message.ticket);
          connectionBinding = {
            ownerId: claims.sub,
            workspaceId: claims.workspaceId,
            buildId: claims.buildId,
            serverInstanceId: claims.serverInstanceId,
            threadId: claims.threadId,
          };
          expiresAt = claims.exp * 1000;
          expiryTimer = setTimeout(
            () => client.close(1008, "Capability expired"),
            Math.max(0, claims.exp * 1000 - Date.now()),
          );
          native = connectNative(
            { ...config, binding: connectionBinding },
            (event) => {
              if (authenticated) {
                try {
                  authorize();
                  send(event);
                } catch {
                  client.close(1008, "Native lifetime revoked");
                }
              }
            },
            () => client.close(1011, "Native session unavailable"),
            registeredHost?.createNativeSocket,
          );
          nativeInfo = await native.call("initialize", {
            clientInfo: { name: "hive_session_bridge", version: "1" },
          });
          check(
            typeof nativeInfo?.userAgent === "string" &&
              /^[^/\s]+\/0\.165\.0(?:\s|$)/.test(nativeInfo.userAgent),
            "Unsupported native protocol version",
          );
          native.notify("initialized");
          check(client.readyState === WebSocket.OPEN);
          authorize();
          authenticated = true;
          clearTimeout(authTimer);
          send({ type: "authenticated", protocolVersion: VERSION, binding: connectionBinding });
          return;
        }
        check(Date.now() < expiresAt, "Capability expired");
        authorize();
        if (own(message, ["type", "ticket"]) && message.type === "renew") {
          try {
            const claims = verifier.accept(message.ticket);
            check(claims.threadId === connectionBinding.threadId, "Renewal cannot switch threads");
            check(claims.exp * 1000 > expiresAt, "Renewal must extend the active capability");
            expiresAt = claims.exp * 1000;
            clearTimeout(expiryTimer);
            expiryTimer = setTimeout(
              () => client.close(1008, "Capability expired"),
              expiresAt - Date.now(),
            );
            send({ type: "renewed", expiresAt: claims.exp });
          } catch {
            // A rejected renewal never extends the previous authorization deadline.
            send({ type: "renewalRejected" });
          }
          return;
        }
        if (own(message, ["method"]) && message.method === "initialized") {
          check(initialized && !acknowledged);
          acknowledged = true;
          return;
        }
        validateRequest(message, connectionBinding.threadId);
        const requestKey = `${typeof message.id}:${message.id}`;
        check(
          !ids.has(requestKey) && ids.size < MAX_REQUESTS && inFlight < 8,
          "Duplicate or excessive RPC request",
        );
        ids.add(requestKey);
        inFlight++;
        try {
          if (message.method === "initialize") {
            check(!initialized);
            initialized = true;
            send({
              id: message.id,
              result: {
                userAgent: nativeInfo.userAgent,
                platformFamily: nativeInfo.platformFamily,
                platformOs: nativeInfo.platformOs,
              },
            });
          } else {
            check(initialized && acknowledged, "Initialize the client first");
            if (message.method === "thread/resume") {
              check(!resumed, "Already subscribed");
              const loaded = await native.call("thread/loaded/list", { limit: 1000 });
              check(
                Array.isArray(loaded?.data) && loaded.data.includes(connectionBinding.threadId),
                "Native thread is not already loaded",
              );
              const result = await native.call("thread/resume", message.params);
              check(result?.thread?.id === connectionBinding.threadId);
              authorize();
              resumed = true;
              send({ id: message.id, result: { thread: { id: connectionBinding.threadId } } });
            } else {
              check(resumed, "Subscribe to the configured thread first");
              const result = await native.call("thread/turns/list", message.params);
              authorize();
              check(
                Array.isArray(result?.data) &&
                  result.data.length <= 100 &&
                  (result.nextCursor === null || typeof result.nextCursor === "string"),
              );
              send({
                id: message.id,
                result: { data: result.data.map(displayTurn), nextCursor: result.nextCursor },
              });
            }
          }
        } catch (error) {
          send({
            id: message.id,
            error: {
              code: error.missing ? -32600 : -32000,
              message: error.missing
                ? `no rollout found for thread id ${connectionBinding.threadId}`
                : "Native session request rejected",
            },
          });
        } finally {
          inFlight--;
        }
      } catch {
        client.close(1008, "Session capability or protocol rejected");
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    unsubscribe?.();
    verifier.close();
    throw error;
  }
  return {
    port: server.address().port,
    close: async () => {
      unsubscribe?.();
      for (const client of websocket.clients) client.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      verifier.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    check(
      process.argv.length === 3,
      "Usage: codex-session-bridge.mjs /absolute/private/config.json",
    );
    privatePath(process.argv[2]);
    const bridge = await startBridge(JSON.parse(readFileSync(process.argv[2], "utf8")));
    process.stdout.write(`Codex read-only session bridge listening on 127.0.0.1:${bridge.port}\n`);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => bridge.close().then(() => process.exit(0)));
  } catch {
    process.stderr.write("Codex session bridge configuration or startup rejected.\n");
    process.exitCode = 1;
  }
}
