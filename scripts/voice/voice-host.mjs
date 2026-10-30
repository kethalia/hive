import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const METHODS = new Set([
  "initialize",
  "initialized",
  "thread/loaded/list",
  "thread/read",
  "thread/realtime/start",
  "thread/realtime/stop",
]);
const exact = (object, keys) =>
  object &&
  typeof object === "object" &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join(",") === [...keys].sort().join(",");

export function voiceConfigDigest(config) {
  const issuerKeySha256 = createHash("sha256")
    .update(createPublicKey(config.issuerPublicKeyPem).export({ type: "spki", format: "der" }))
    .digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        issuer: config.issuer,
        audience: config.audience,
        issuerKeyId: config.issuerKeyId,
        issuerKeySha256,
        workspaceId: config.workspaceId,
        buildId: config.buildId,
        agentId: config.agentId,
        lockDirectory: config.lockDirectory,
        manifestSha256: config.manifestSha256,
      }),
    )
    .digest("hex");
}
/** Fixed workspace-local service. Config and issuer key must be provisioned by the trusted installer. */
export function createVoiceHost(config, dependencies = {}) {
  const issuer = createPublicKey(config.issuerPublicKeyPem);
  const validOrigin = (value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && u.origin === value && !u.username && !u.password;
    } catch {
      return false;
    }
  };
  if (
    issuer.asymmetricKeyType !== "ed25519" ||
    !UUID.test(config.workspaceId) ||
    !UUID.test(config.buildId) ||
    !UUID.test(config.agentId) ||
    !validOrigin(config.issuer) ||
    !validOrigin(config.audience) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(config.issuerKeyId) ||
    !/^[a-f0-9]{64}$/.test(config.manifestSha256) ||
    typeof config.lockDirectory !== "string" ||
    !config.lockDirectory.startsWith("/")
  )
    throw new Error("invalid_voice_config");
  const used = new Map();
  const lifetimeId = randomUUID();
  const identityKey = generateKeyPairSync("ed25519");
  let active = 0;
  function authorize(req, scope) {
    const bearer = req.headers.authorization;
    if (typeof bearer !== "string" || !bearer.startsWith("Bearer ") || bearer.length > 4096)
      throw new Error();
    const parts = bearer.slice(7).split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (
      !exact(header, ["alg", "typ", "kid"]) ||
      header.alg !== "EdDSA" ||
      header.typ !== "JWT" ||
      header.kid !== config.issuerKeyId ||
      !verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        issuer,
        Buffer.from(parts[2], "base64url"),
      ) ||
      !exact(claims, [
        "iss",
        "aud",
        "scope",
        "jti",
        "iat",
        "exp",
        "workspaceId",
        "buildId",
        "agentId",
        "threadId",
        "lifetimeId",
      ]) ||
      claims.iss !== config.issuer ||
      claims.aud !== config.audience ||
      claims.scope !== scope ||
      typeof claims.jti !== "string" ||
      !UUID.test(claims.jti) ||
      claims.workspaceId !== config.workspaceId ||
      claims.buildId !== config.buildId ||
      claims.agentId !== config.agentId ||
      !(
        claims.threadId === null ||
        (typeof claims.threadId === "string" && UUID.test(claims.threadId))
      ) ||
      (scope === "voice:identity:v1"
        ? claims.threadId !== null || claims.lifetimeId !== null
        : claims.lifetimeId !== lifetimeId) ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat > now + 2 ||
      claims.exp <= now ||
      claims.exp - claims.iat > 15 ||
      claims.iat < now - 15
    )
      throw new Error();
    for (const [id, exp] of used) if (exp <= now) used.delete(id);
    if (used.has(claims.jti) || used.size >= 4096) throw new Error();
    used.set(claims.jti, claims.exp);
    return claims;
  }
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz" && dependencies.configFileSha256) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
        JSON.stringify({
          schemaVersion: 1,
          lifetimeId,
          configDigest: voiceConfigDigest(config),
          manifestSha256: config.manifestSha256,
          configFileSha256: dependencies.configFileSha256,
        }),
      );
      return;
    }
    try {
      if (req.method !== "GET" || req.url !== "/voice/identity") throw new Error();
      const claims = authorize(req, "voice:identity:v1");
      const identity = {
        requestId: claims.jti,
        lifetimeId,
        workspaceId: config.workspaceId,
        buildId: config.buildId,
        agentId: config.agentId,
        manifestSha256: config.manifestSha256,
        configDigest: voiceConfigDigest(config),
        publicKeyPem: identityKey.publicKey.export({ type: "spki", format: "pem" }),
      };
      const proof = sign(
        null,
        Buffer.from(`hive-voice-identity-v1\n${JSON.stringify(identity)}`),
        identityKey.privateKey,
      ).toString("base64url");
      res
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ ...identity, proof }));
    } catch {
      res.writeHead(404).end();
    }
  });
  const upgrades = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const reject = () => socket.destroy();
    try {
      if (req.url !== "/voice" || req.method !== "GET" || active >= 16) return reject();
      const claims = authorize(req, "voice:connect:v1");
      active++;
      const failedUpgrade = () => {
        active--;
      };
      socket.once("close", failedUpgrade);
      upgrades.handleUpgrade(req, socket, head, (browser) => {
        socket.removeListener("close", failedUpgrade);
        let child,
          upstream,
          ended = false,
          totalIn = 0,
          totalOut = 0;
        const queued = [];
        const timer = setTimeout(() => finish(), 30 * 60_000);
        function finish() {
          if (ended) return;
          ended = true;
          active--;
          clearTimeout(timer);
          browser.terminate();
          upstream?.terminate();
          child?.kill();
        }
        browser.on("error", finish);
        browser.on("close", finish);
        try {
          // Arguments are fixed; the sole dynamic value is a strictly validated UUID.
          const args = claims.threadId
            ? [
                "-n",
                "-F",
                `${config.lockDirectory}/${claims.threadId.toLowerCase()}.lock`,
                "codex",
                "app-server",
                "proxy",
              ]
            : ["app-server", "proxy"];
          child = (dependencies.spawn ?? spawn)(claims.threadId ? "flock" : "codex", args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: dependencies.env ?? process.env,
          });
          child.stderr.resume();
          child.on("error", finish);
          child.on("exit", finish);
          const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
          upstream = new WebSocket("ws://localhost/", {
            createConnection: () => stream,
            handshakeTimeout: 10000,
            maxPayload: MAX_FRAME,
            perMessageDeflate: false,
          });
          stream.on("error", finish);
          upstream.on("error", finish);
          upstream.on("close", finish);
          upstream.on("open", () => {
            for (const data of queued.splice(0))
              upstream.send(data, { binary: false }, (error) => {
                if (error) finish();
              });
          });
          browser.on("message", (data, binary) => {
            try {
              totalIn += data.length;
              if (binary || totalIn > MAX_TOTAL || upstream.bufferedAmount > MAX_FRAME)
                return finish();
              const msg = JSON.parse(data.toString());
              if (
                !msg ||
                typeof msg !== "object" ||
                !METHODS.has(msg.method) ||
                (msg.method.startsWith("thread/realtime/") &&
                  (!claims.threadId || msg.params?.threadId !== claims.threadId))
              )
                return finish();
              if (upstream.readyState === WebSocket.CONNECTING) {
                if (
                  queued.length >= 16 ||
                  queued.reduce((sum, item) => sum + item.length, 0) + data.length > MAX_FRAME
                )
                  return finish();
                queued.push(data);
              } else if (upstream.readyState === WebSocket.OPEN)
                upstream.send(data, { binary: false }, (error) => {
                  if (error) finish();
                });
              else finish();
            } catch {
              finish();
            }
          });
          upstream.on("message", (data, binary) => {
            totalOut += data.length;
            if (totalOut > MAX_TOTAL || browser.bufferedAmount > MAX_FRAME) return finish();
            browser.send(data, { binary }, (error) => {
              if (error) finish();
            });
          });
        } catch {
          finish();
        }
      });
    } catch {
      reject();
    }
  });
  return {
    server,
    close: () => {
      for (const client of upgrades.clients) client.terminate();
      upgrades.close();
      server.close();
    },
  };
}
