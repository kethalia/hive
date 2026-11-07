import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { createCodexAccountManager } from "./codex-account.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^(codex|claude)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPS = [
  "rename-terminal-session",
  "kill-terminal-session",
  "identity",
  "codex-account",
  "inventory",
  "sessions",
  "install",
  "disable",
  "configure-coder",
  "install-notifications",
  "resume",
];
const BINDING = [
  "coderOrigin",
  "ownerId",
  "workspaceId",
  "buildId",
  "agentId",
  "templateId",
  "appOrigin",
  "appId",
];
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (value) =>
  JSON.stringify(
    (function sort(v) {
      return Array.isArray(v)
        ? v.map(sort)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, sort(x)]),
            )
          : v;
    })(value),
  );
export const responsePayload = (value) =>
  `hive-agent-response-v1\nPOST\n/agent/operation\n${canonical(value)}`;
export function configDigest(config, environment = {}) {
  const issuerPublicKeySha256 = sha(
    createPublicKey(config.issuerPublicKeyPem).export({ type: "spki", format: "der" }),
  );
  return sha(
    canonical({
      schemaVersion: 1,
      issuer: config.issuer,
      issuerKeyId: config.issuerKeyId,
      issuerPublicKeySha256,
      binding: config.binding,
      profile: config.profile,
      home: config.home,
      manifestSha256: config.manifestSha256,
      helperSha256: config.helperSha256,
      environment,
    }),
  );
}
function validOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function operationValid(v) {
  if (!v || !OPS.includes(v.operation)) return false;
  const sessionName = (name) =>
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) &&
    !name.startsWith("git-clone-");
  if (v.operation === "rename-terminal-session")
    return (
      exact(v, ["operation", "oldName", "newName"]) &&
      sessionName(v.oldName) &&
      sessionName(v.newName)
    );
  if (v.operation === "kill-terminal-session")
    return exact(v, ["operation", "sessionName"]) && sessionName(v.sessionName);
  if (v.operation === "codex-account") {
    const a = v.account;
    return (
      exact(v, ["operation", "account"]) &&
      (a?.action === "status"
        ? exact(a, ["action"])
        : a &&
          ["connect", "cancel", "reconnect", "disconnect"].includes(a.action) &&
          exact(a, ["action", "lifetimeId", "generation"]) &&
          UUID.test(a.lifetimeId) &&
          Number.isSafeInteger(a.generation) &&
          a.generation >= 0)
    );
  }
  if (v.operation === "resume")
    return exact(v, ["operation", "key"]) && typeof v.key === "string" && KEY.test(v.key);
  if (v.operation === "install-notifications")
    return (
      exact(v, ["operation", "sourceId", "generation", "createdAt", "token"]) &&
      UUID.test(v.sourceId) &&
      Number.isSafeInteger(v.generation) &&
      v.generation >= 1 &&
      typeof v.createdAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.createdAt) &&
      Number.isFinite(Date.parse(v.createdAt)) &&
      new Date(v.createdAt).toISOString() === v.createdAt &&
      typeof v.token === "string" &&
      /^[a-f0-9]{64}$/.test(v.token)
    );
  return exact(v, ["operation"]);
}
function pinnedSource(path, expected, maximum = 65536) {
  if (realpathSync(path) !== path) throw new Error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.size < 1 ||
      info.size > maximum
    )
      throw new Error();
    const raw = readFileSync(fd);
    if (raw.length !== info.size || sha(raw) !== expected) throw new Error();
    return raw;
  } finally {
    closeSync(fd);
  }
}

/** Config is installer-owned. This factory is inert until an explicit loopback listen. */
export function createAgentBridge(config, deps = {}) {
  const issuer = createPublicKey(config.issuerPublicKeyPem);
  if (
    issuer.asymmetricKeyType !== "ed25519" ||
    !validOrigin(config.issuer) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(config.issuerKeyId) ||
    !exact(config.binding, BINDING) ||
    !validOrigin(config.binding.coderOrigin) ||
    !validOrigin(config.binding.appOrigin) ||
    BINDING.filter((v) => !v.endsWith("Origin")).some((v) => !UUID.test(config.binding[v])) ||
    !["software", "browser", "game", "electronics", "infrastructure"].includes(config.profile) ||
    typeof config.home !== "string" ||
    !config.home.startsWith("/") ||
    !/^[a-f0-9]{64}$/.test(config.helperSha256) ||
    !/^[a-f0-9]{64}$/.test(config.manifestSha256)
  )
    throw new Error("agent_config_rejected");
  const environment = deps.environment ?? {};
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.keys(environment).some((key) => !["CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(key)) ||
    Object.values(environment).some(
      (value) =>
        typeof value !== "string" ||
        value.length > 4096 ||
        !isAbsolute(value) ||
        normalize(value) !== value ||
        Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    )
  )
    throw new Error("agent_config_rejected");
  const key = generateKeyPairSync("ed25519"),
    lifetimeId = randomUUID(),
    used = new Map();
  const accounts = createCodexAccountManager({
    home: config.home,
    profile: config.profile,
    lifetimeId,
    ...(deps.accounts ?? {}),
  });
  const helper = deps.helperPath;
  if (typeof helper !== "string" || !helper.startsWith("/"))
    throw new Error("agent_config_rejected");
  let active = 0;
  function ticket(token) {
    if (typeof token !== "string" || token.length > 8192) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], "base64url")),
      c = JSON.parse(Buffer.from(parts[1], "base64url")),
      now = Math.floor(Date.now() / 1000);
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
      !exact(c, ["iss", "aud", "scope", "jti", "iat", "exp", "lifetimeId", "binding", "request"]) ||
      c.iss !== config.issuer ||
      c.aud !== config.binding.appOrigin ||
      c.scope !== "agent:operation:v1" ||
      typeof c.jti !== "string" ||
      !UUID.test(c.jti) ||
      !Number.isSafeInteger(c.iat) ||
      !Number.isSafeInteger(c.exp) ||
      c.iat > now + 2 ||
      c.iat < now - 60 ||
      c.exp <= now ||
      c.exp - c.iat > 60 ||
      !exact(c.binding, [...BINDING, "hiveUserId"]) ||
      !UUID.test(c.binding.hiveUserId) ||
      BINDING.some((name) => c.binding[name] !== config.binding[name]) ||
      !operationValid(c.request) ||
      (c.request.operation === "identity" ? c.lifetimeId !== null : c.lifetimeId !== lifetimeId)
    )
      throw new Error();
    for (const [id, exp] of used) if (exp <= now) used.delete(id);
    if (used.has(c.jti) || used.size >= 4096) throw new Error();
    used.set(c.jti, c.exp);
    return c;
  }
  function execute(request) {
    if (request.operation === "codex-account") return accounts.run(request.account);
    return new Promise((resolve, reject) => {
      let source, payload;
      try {
        source = pinnedSource(helper, config.helperSha256);
        payload = {
          ...request,
          ...(request.operation === "install" ? { source: source.toString("utf8") } : {}),
        };
        if (request.operation === "install-notifications") {
          const directory = dirname(helper);
          const manifest = JSON.parse(
            pinnedSource(join(directory, "manifest.json"), config.manifestSha256, 4096),
          );
          const names = [
            "agent-host.mjs",
            "codex-account.mjs",
            "agent-start.mjs",
            "agent-tools.py",
            "notifications-install.py",
            "notifications-hook.py",
          ];
          if (
            !exact(manifest, ["schemaVersion", "files"]) ||
            manifest.schemaVersion !== 1 ||
            !exact(manifest.files, names) ||
            names.some((name) => !/^[a-f0-9]{64}$/.test(manifest.files[name]))
          )
            throw new Error();
          source = pinnedSource(
            join(directory, "notifications-install.py"),
            manifest.files["notifications-install.py"],
          );
          const hook = pinnedSource(
            join(directory, "notifications-hook.py"),
            manifest.files["notifications-hook.py"],
          );
          payload = {
            ...request,
            portable: true,
            hook: hook.toString("utf8"),
            url: `${config.issuer}/api/notifications/events`,
          };
        }
      } catch {
        return reject(new Error());
      }
      const child = (deps.spawn ?? spawn)(
        "/usr/bin/python3",
        ["-I", "-B", "-c", source.toString("utf8")],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            HOME: config.home,
            USER: "coder",
            PATH: `${config.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
            LANG: "C.UTF-8",
            HIVE_WORKSPACE_PROFILE: config.profile,
            ...environment,
          },
          detached: true,
        },
      );
      let bytes = 0,
        chunks = [],
        ended = false;
      const done = (error, data) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (error) {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
          reject(error);
        } else resolve(data);
      };
      const timer = setTimeout(() => done(new Error()), 30000);
      child.stderr.resume();
      child.stdin.on("error", () => done(new Error()));
      child.on("error", () => done(new Error()));
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) done(new Error());
        else chunks.push(chunk);
      });
      child.on("close", (code) => {
        try {
          if (code !== 0 || ended) return done(new Error());
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!exact(result, ["ok", "data"]) || result.ok !== true) return done(new Error());
          done(null, result.data);
        } catch {
          done(new Error());
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz" && deps.configFileSha256) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
        JSON.stringify({
          schemaVersion: 1,
          lifetimeId,
          configDigest: configDigest(config, environment),
          manifestSha256: config.manifestSha256,
          helperSha256: config.helperSha256,
          profile: config.profile,
          configFileSha256: deps.configFileSha256,
        }),
      );
      return;
    }
    let counted = false;
    let bodyTimer;
    try {
      if (
        req.method !== "POST" ||
        req.url !== "/agent/operation" ||
        active >= 4 ||
        req.headers["content-type"] !== "application/json"
      )
        throw new Error();
      active++;
      counted = true;
      bodyTimer = setTimeout(() => req.destroy(), 5000);
      let bytes = 0,
        chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error();
        chunks.push(chunk);
      }
      clearTimeout(bodyTimer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!exact(body, ["ticket"])) throw new Error();
      const c = ticket(body.ticket);
      let result;
      if (c.request.operation === "identity")
        result = {
          ok: true,
          data: {
            publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }),
            configDigest: configDigest(config, environment),
            manifestSha256: config.manifestSha256,
            environment,
          },
        };
      else {
        try {
          result = { ok: true, data: await execute(c.request) };
        } catch {
          result = { ok: false, error: "agent_operation_failed" };
        }
      }
      const unsigned = {
        schemaVersion: 1,
        requestId: c.jti,
        lifetimeId,
        operation: c.request.operation,
        result,
      };
      const proof = sign(null, Buffer.from(responsePayload(unsigned)), key.privateKey).toString(
        "base64url",
      );
      const output = JSON.stringify({ ...unsigned, proof });
      if (Buffer.byteLength(output) > 8 * 1024 * 1024 + 16384) throw new Error();
      res
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(output);
    } catch {
      if (!res.headersSent) res.writeHead(400, { "Cache-Control": "no-store" }).end();
      else res.destroy();
    } finally {
      clearTimeout(bodyTimer);
      if (counted) active--;
    }
  });
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 32;
  return {
    server,
    close: async () => {
      server.close();
      await accounts.close();
    },
  };
}
