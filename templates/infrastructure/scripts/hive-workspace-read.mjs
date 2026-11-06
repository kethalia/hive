// Independent installed read service; no project/native/guardian startup imports.
import { execFileSync, spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const check = (v) => {
  if (!v) throw new Error("workspace_read_rejected");
};
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === keys.slice().sort().join();
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const path = (v) =>
  typeof v === "string" &&
  v.startsWith("/") &&
  v.length <= 4096 &&
  !v.includes("\\") &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
  resolve(v) === v;
const profiles = ["software", "browser", "game", "electronics", "infrastructure"];
const session = (v) => typeof v === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(v);
const bindingKeys = [
  "coderOrigin",
  "ownerId",
  "workspaceId",
  "buildId",
  "agentId",
  "templateId",
  "appOrigin",
  "appId",
];
export const workspaceReadCanonical = (v) =>
  JSON.stringify(
    (function sorted(x) {
      return Array.isArray(x)
        ? x.map(sorted)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.entries(x)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, y]) => [k, sorted(y)]),
            )
          : x;
    })(v),
  );
const sha = (v) => createHash("sha256").update(v).digest("hex");
export const workspaceReadResponsePayload = (v) =>
  `hive-workspace-read-response-v1\nPOST\n/workspace/read\n${workspaceReadCanonical(v)}`;
export function workspaceReadConfigDescriptor(c) {
  const issuer = createPublicKey(c.issuerPublicKeyPem);
  check(issuer.asymmetricKeyType === "ed25519");
  return {
    schemaVersion: 1,
    profile: c.profile,
    projectsRoot: c.projectsRoot,
    home: c.home,
    hiveOrigin: c.hiveOrigin,
    issuerKeyId: c.issuerKeyId,
    issuerPublicKeySha256: sha(issuer.export({ type: "spki", format: "der" })),
    binding: c.binding,
    port: c.port,
  };
}
function origin(v) {
  const u = new URL(v);
  check(u.protocol === "https:" && u.origin === v && !u.username && !u.password);
  return u;
}
function privateFile(p, max) {
  check(realpathSync(p) === p);
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    check(
      s.isFile() &&
        s.uid === process.getuid() &&
        s.nlink === 1 &&
        !(s.mode & 0o077) &&
        s.size <= max,
    );
    const raw = readFileSync(fd);
    check(raw.length <= max);
    return raw;
  } finally {
    closeSync(fd);
  }
}
function atomic(p, value) {
  const temp = `${p}.${randomUUID()}.tmp`,
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, p);
  const dir = openSync(dirname(p), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function requestShape(r) {
  check(r && ["identity", "sessions", "directory", "paths"].includes(r.operation));
  if (r.operation === "identity") check(exact(r, ["operation"]));
  else if (r.operation === "sessions")
    check(
      exact(r, Object.hasOwn(r, "cursor") ? ["operation", "cursor"] : ["operation"]) &&
        (!Object.hasOwn(r, "cursor") || (typeof r.cursor === "string" && r.cursor.length <= 256)),
    );
  else if (r.operation === "directory")
    check(exact(r, ["operation", "sessionName"]) && session(r.sessionName));
  else
    check(
      exact(
        r,
        Object.hasOwn(r, "fallbackPath")
          ? ["operation", "sessionName", "fallbackPath", "paths"]
          : ["operation", "sessionName", "paths"],
      ) &&
        session(r.sessionName) &&
        Array.isArray(r.paths) &&
        r.paths.length <= 128 &&
        r.paths.every((p) => typeof p === "string" && p.length > 0 && p.length <= 4096) &&
        (!Object.hasOwn(r, "fallbackPath") ||
          (typeof r.fallbackPath === "string" &&
            r.fallbackPath.length > 0 &&
            r.fallbackPath.length <= 4096)),
    );
  check(Buffer.byteLength(JSON.stringify(r)) <= 540672);
  return r;
}
const helperErrors = new Set([
  "unsupported_profile_operation",
  "request_too_large",
  "tmux_unavailable",
  "tmux_timeout",
  "too_many_sessions",
  "stale_cursor",
  "invalid_cursor",
  "unsupported_session_name",
  "directory_unavailable",
  "read_unavailable",
]);
export function validateWorkspaceReadConfig(config) {
  check(
    exact(config, [
      "schemaVersion",
      "binding",
      "profile",
      "projectsRoot",
      "home",
      "hiveOrigin",
      "issuerKeyId",
      "issuerPublicKeyPem",
      "packageDirectory",
      "manifestSha256",
      "stateDirectory",
      "port",
    ]) &&
      config.schemaVersion === 1 &&
      profiles.includes(config.profile) &&
      path(config.projectsRoot) &&
      path(config.home) &&
      path(config.packageDirectory) &&
      path(config.stateDirectory) &&
      hex(config.manifestSha256) &&
      typeof config.issuerPublicKeyPem === "string" &&
      config.issuerPublicKeyPem.length <= 256 &&
      config.issuerPublicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n") &&
      !config.issuerPublicKeyPem.includes("PRIVATE") &&
      /^[A-Za-z0-9._-]{1,64}$/.test(config.issuerKeyId) &&
      config.port === 13342 &&
      exact(config.binding, bindingKeys) &&
      bindingKeys.every((k) =>
        k.endsWith("Origin") ? typeof config.binding[k] === "string" : uuid(config.binding[k]),
      ),
  );
  origin(config.hiveOrigin);
  origin(config.binding.coderOrigin);
  origin(config.binding.appOrigin);
  check(
    config.stateDirectory ===
      join(config.home, ".local/state/hive/workspace-read", config.binding.buildId),
  );
  const issuer = createPublicKey(config.issuerPublicKeyPem);
  check(
    issuer.asymmetricKeyType === "ed25519" &&
      issuer.export({ type: "spki", format: "pem" }) === config.issuerPublicKeyPem,
  );
  return config;
}
export function readWorkspaceReadStartup(context = {}) {
  const home = context.home ?? userInfo().homedir,
    profile = context.profile ?? process.env.HIVE_WORKSPACE_PROFILE,
    packageDirectory = context.packageDirectory ?? dirname(fileURLToPath(import.meta.url)),
    configPath = join(home, ".config/hive/workspace-read.json");
  for (const parent of [dirname(dirname(configPath)), dirname(configPath)]) {
    check(realpathSync(parent) === parent);
    const s = lstatSync(parent);
    check(s.isDirectory() && s.uid === process.getuid() && !(s.mode & 0o022));
  }
  const raw = privateFile(configPath, 32768),
    config = validateWorkspaceReadConfig(JSON.parse(raw));
  check(
    config.home === home &&
      config.profile === profile &&
      config.packageDirectory === packageDirectory,
  );
  return { config, configSha256: sha(raw) };
}
/** Trusted installation config only. socketDirectory/listenPort are test
 * dependencies, never installed config fields or HTTP request inputs. */
export function createWorkspaceReadService(config, dependencies = {}) {
  config = validateWorkspaceReadConfig(config);
  const app = origin(config.binding.appOrigin),
    issuer = createPublicKey(config.issuerPublicKeyPem);
  const manifestPath = join(config.packageDirectory, "manifest.json"),
    manifestRaw = privateFile(manifestPath, 4096),
    manifest = JSON.parse(manifestRaw);
  check(
    sha(manifestRaw) === config.manifestSha256 &&
      exact(manifest, ["schemaVersion", "files"]) &&
      manifest.schemaVersion === 1 &&
      exact(manifest.files, ["hive-workspace-read.mjs", "hive-workspace-read.py"]) &&
      Object.values(manifest.files).every(hex),
  );
  const ownPath = fileURLToPath(import.meta.url),
    helper = join(config.packageDirectory, "hive-workspace-read.py");
  // Tests can import the source module while constructing an identical private
  // package; the installed manifest always pins the exact service source bytes.
  const servicePath = join(config.packageDirectory, "hive-workspace-read.mjs");
  check(
    realpathSync(servicePath) === servicePath &&
      sha(readFileSync(servicePath)) === manifest.files["hive-workspace-read.mjs"] &&
      sha(readFileSync(ownPath)) === manifest.files["hive-workspace-read.mjs"],
  );
  const assertHelper = () => {
    check(realpathSync(helper) === helper);
    const s = lstatSync(helper);
    check(
      s.isFile() &&
        s.nlink === 1 &&
        s.uid === process.getuid() &&
        !(s.mode & 0o022) &&
        s.size <= 65536 &&
        sha(readFileSync(helper)) === manifest.files["hive-workspace-read.py"],
    );
  };
  assertHelper();
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  check(realpathSync(config.stateDirectory) === config.stateDirectory);
  const stateStat = lstatSync(config.stateDirectory);
  check(stateStat.isDirectory() && stateStat.uid === process.getuid() && !(stateStat.mode & 0o077));
  const lock = openSync(
    join(config.stateDirectory, "service.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const ls = fstatSync(lock);
  check(ls.isFile() && ls.uid === process.getuid() && ls.nlink === 1 && !(ls.mode & 0o077));
  try {
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
      timeout: 2000,
      env: { PATH: "/usr/bin:/bin" },
    });
  } catch (error) {
    closeSync(lock);
    throw error;
  }
  const lifetimeId = randomUUID(),
    keys = generateKeyPairSync("ed25519"),
    publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    configDigest = sha(workspaceReadCanonical(workspaceReadConfigDescriptor(config))),
    cachePath = join(config.stateDirectory, "nonces.json");
  let nonces = new Map(),
    closed = false,
    busy = false,
    child;
  try {
    const raw = privateFile(cachePath, 524288),
      saved = JSON.parse(raw);
    check(
      Array.isArray(saved) &&
        saved.length <= 4096 &&
        saved.every(
          (v) => Array.isArray(v) && v.length === 2 && uuid(v[0]) && Number.isSafeInteger(v[1]),
        ),
    );
    nonces = new Map(saved);
  } catch (error) {
    if (error.code !== "ENOENT") {
      closeSync(lock);
      throw error;
    }
  }
  function ticket(value) {
    check(
      !closed &&
        exact(value, ["ticket"]) &&
        typeof value.ticket === "string" &&
        Buffer.byteLength(value.ticket) <= 786432,
    );
    const parts = value.ticket.split(".");
    check(
      parts.length === 3 &&
        parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)) &&
        parts[0].length <= 512 &&
        parts[2].length === 86,
    );
    const header = JSON.parse(Buffer.from(parts[0], "base64url")),
      c = JSON.parse(Buffer.from(parts[1], "base64url"));
    check(
      exact(header, ["alg", "typ", "kid"]) &&
        header.alg === "EdDSA" &&
        header.typ === "JWT" &&
        header.kid === config.issuerKeyId &&
        verify(
          null,
          Buffer.from(`${parts[0]}.${parts[1]}`),
          issuer,
          Buffer.from(parts[2], "base64url"),
        ),
    );
    const now = Math.floor(Date.now() / 1000);
    check(
      exact(c, [
        "iss",
        "aud",
        "scope",
        "jti",
        "iat",
        "exp",
        "lifetimeId",
        "profile",
        "binding",
        "request",
      ]) &&
        c.iss === config.hiveOrigin &&
        c.aud === config.binding.appOrigin &&
        c.scope === "workspace:read:v1" &&
        uuid(c.jti) &&
        Number.isSafeInteger(c.iat) &&
        Number.isSafeInteger(c.exp) &&
        c.iat <= now &&
        c.exp > now &&
        c.exp - c.iat > 0 &&
        c.exp - c.iat <= 30 &&
        c.profile === config.profile &&
        exact(c.binding, [...bindingKeys, "hiveUserId"]) &&
        uuid(c.binding.hiveUserId) &&
        bindingKeys.every((k) => c.binding[k] === config.binding[k]),
    );
    requestShape(c.request);
    check(c.request.operation === "identity" ? c.lifetimeId === null : c.lifetimeId === lifetimeId);
    nonces = new Map([...nonces].filter(([, exp]) => exp > now));
    check(nonces.size < 4096 && !nonces.has(c.jti));
    nonces.set(c.jti, c.exp);
    atomic(cachePath, JSON.stringify([...nonces]));
    return c;
  }
  function run(request) {
    check(!closed && !busy);
    assertHelper();
    busy = true;
    return new Promise((done, reject) => {
      child = spawn("/usr/bin/python3", ["-I", "-B", helper], {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: config.home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const owned = child;
      let stdout = Buffer.alloc(0),
        stderrBytes = 0,
        failure = false;
      const fail = () => {
        failure = true;
        if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
      };
      const timer = setTimeout(fail, 5000);
      owned.stdout.on("data", (b) => {
        stdout = Buffer.concat([stdout, b]);
        if (stdout.length > 131072) fail();
      });
      owned.stderr.on("data", (b) => {
        stderrBytes += b.length;
        if (stderrBytes > 4096) fail();
      });
      owned.once("error", () => {
        failure = true;
      });
      owned.once("close", (code) => {
        clearTimeout(timer);
        busy = false;
        if (child === owned) child = null;
        try {
          check(!closed && !failure && code === 0);
          assertHelper();
          const result = JSON.parse(stdout);
          check(
            result?.ok === true
              ? exact(result, ["ok", "data"])
              : exact(result, ["ok", "error"]) &&
                  result.ok === false &&
                  helperErrors.has(result.error),
          );
          done(result);
        } catch (error) {
          reject(error);
        }
      });
      owned.stdin.on("error", () => {});
      owned.stdin.end(
        JSON.stringify({
          config: {
            profile: config.profile,
            projectsRoot: config.projectsRoot,
            home: config.home,
            socketDirectory: dependencies.socketDirectory ?? null,
          },
          request,
        }),
      );
    });
  }
  function assertPackage() {
    assertHelper();
    check(
      sha(privateFile(manifestPath, 4096)) === config.manifestSha256 &&
        sha(readFileSync(servicePath)) === manifest.files["hive-workspace-read.mjs"] &&
        sha(readFileSync(ownPath)) === manifest.files["hive-workspace-read.mjs"],
    );
  }
  async function dispatch(value) {
    assertPackage();
    const c = ticket(value);
    let result;
    if (c.request.operation === "identity")
      result = {
        ok: true,
        data: {
          profile: config.profile,
          projectsRoot: config.projectsRoot,
          manifestSha256: config.manifestSha256,
          configDigest,
          publicKeyPem,
        },
      };
    else {
      try {
        result = await run(c.request);
      } catch {
        result = { ok: false, error: "read_unavailable" };
      }
    }
    assertPackage();
    check(!closed && c.exp > Math.floor(Date.now() / 1000));
    const body = {
      schemaVersion: 1,
      requestId: c.jti,
      lifetimeId,
      operation: c.request.operation,
      readOnly: true,
      result,
    };
    return {
      ...body,
      proof: sign(null, Buffer.from(workspaceReadResponsePayload(body)), keys.privateKey).toString(
        "base64url",
      ),
    };
  }
  let requests = 0;
  const server = createServer(
    {
      requestTimeout: 8000,
      headersTimeout: 3000,
      keepAliveTimeout: 1000,
      maxHeaderSize: 8192,
      connectionsCheckingInterval: 1000,
    },
    async (req, res) => {
      requests++;
      res.setTimeout(8000, () => res.destroy());
      try {
        check(!closed && requests <= 4);
        if (req.method === "GET" && req.url === "/healthz") {
          check(req.headers.host === app.host && !Object.hasOwn(req.headers, "origin"));
          assertPackage();
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(
            JSON.stringify({
              schemaVersion: 1,
              readOnly: true,
              lifetimeId,
              configDigest,
              manifestSha256: config.manifestSha256,
              profile: config.profile,
              configFileSha256: dependencies.configFileSha256 ?? null,
            }),
          );
          return;
        }
        check(
          req.method === "POST" &&
            req.url === "/workspace/read" &&
            req.headers.host === app.host &&
            !Object.hasOwn(req.headers, "origin") &&
            req.headers["content-type"]?.split(";")[0] === "application/json" &&
            !req.headers["content-encoding"],
        );
        const n = req.headers["content-length"];
        check(!n || (/^\d+$/.test(n) && Number(n) <= 786432));
        const timer = setTimeout(() => req.destroy(), 2000),
          chunks = [];
        let bytes = 0,
          count = 0;
        let value;
        try {
          for await (const chunk of req) {
            bytes += chunk.length;
            count++;
            check(bytes <= 786432 && count <= 1024);
            chunks.push(chunk);
          }
          value = JSON.parse(Buffer.concat(chunks));
        } finally {
          clearTimeout(timer);
        }
        const result = await dispatch(value);
        check(!closed && !res.destroyed);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        });
        res.end(JSON.stringify(result));
      } catch {
        if (!res.destroyed) {
          res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end('{"error":"workspace_read_unavailable"}');
        }
      } finally {
        requests--;
      }
    },
  );
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 32;
  return {
    dispatch,
    lifetimeId,
    configDigest,
    async listen() {
      check(!closed);
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(dependencies.listenPort ?? config.port, "127.0.0.1", done);
      });
      return server.address();
    },
    async close() {
      if (closed) return;
      closed = true;
      const owned = child,
        drained = owned ? new Promise((done) => owned.once("close", done)) : Promise.resolve();
      if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
      await new Promise((done) => server.close(done));
      await drained;
      closeSync(lock);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let service;
  try {
    check(process.argv.length === 2);
    const { config, configSha256 } = readWorkspaceReadStartup();
    service = createWorkspaceReadService(config, { configFileSha256: configSha256 });
    await service.listen();
    const close = () => {
      void service.close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  } catch {
    try {
      await service?.close();
    } catch {}
    process.stderr.write("workspace_read_startup_failed\n");
    process.exitCode = 1;
  }
}
