// Installed, owner-only app handler. No native runtime, model, shell, or CLI startup.
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { projectScopes, validateProjectOperation } from "./codex-project-controller.mjs";

const check = (v) => {
  if (!v) throw new Error("discovery_rejected");
};
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const id = (v) => typeof v === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const helperErrors = new Set([
  "workspace_agent_required",
  "external_auth_timeout",
  "external_auth_invalid_response",
  "external_auth_unavailable",
  "github_auth_required",
  "github_invalid_response",
  "github_invalid_pagination",
  "pagination_limit_reached",
  "github_response_too_large",
  "github_timeout",
  "github_unavailable",
  "github_rate_limited",
  "github_permission_denied",
  "github_redirect_rejected",
  "discovery_unavailable",
]);
const bindingKeys = [
  "coderOrigin",
  "hiveUserId",
  "ownerId",
  "workspaceId",
  "buildId",
  "agentId",
  "templateId",
  "appOrigin",
  "appId",
];
function privatePath(path, directory = false) {
  check(isAbsolute(path) && realpathSync(path) === path);
  const s = lstatSync(path);
  check(
    s.uid === process.getuid() && !(s.mode & 0o077) && (directory ? s.isDirectory() : s.isFile()),
  );
}
/** All config is provisioned independently; HTTP cannot choose identities, roots,
 * executables, URLs or credentials. Keep this under the installed wrapper's lock. */
export function createProjectDiscovery(config, controller) {
  check(
    exact(config, [
      "binding",
      "hiveOrigin",
      "issuerPublicKeyPem",
      "issuerKeyId",
      "stateDirectory",
      "helperPath",
      "helperSha256",
    ]),
  );
  check(
    exact(config.binding, bindingKeys) &&
      bindingKeys.every((k) => id(config.binding[k]) || k.endsWith("Origin")),
  );
  for (const value of [config.hiveOrigin, config.binding.coderOrigin, config.binding.appOrigin]) {
    const u = new URL(value);
    check(u.protocol === "https:" && u.origin === value && !u.username && !u.password);
  }
  check(id(config.issuerKeyId));
  const key = createPublicKey(config.issuerPublicKeyPem);
  check(key.asymmetricKeyType === "ed25519");
  privatePath(config.stateDirectory, true);
  check(
    isAbsolute(config.helperPath) &&
      realpathSync(config.helperPath) === config.helperPath &&
      /^[a-f0-9]{64}$/.test(config.helperSha256),
  );
  const helper = lstatSync(config.helperPath);
  check(helper.isFile() && !(helper.mode & 0o022));
  const replayPath = join(
    config.stateDirectory,
    `project-discovery-${createHash("sha256")
      .update(JSON.stringify(bindingKeys.map((k) => config.binding[k])))
      .digest("hex")}.json`,
  );
  const fd = openSync(
    `${replayPath}.lock`,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let nonces = new Map(),
    closed = false,
    busy = false;
  try {
    const s = fstatSync(fd);
    check(s.isFile() && s.uid === process.getuid() && !(s.mode & 0o077));
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
    });
    if (existsSync(replayPath)) {
      privatePath(replayPath);
      check(lstatSync(replayPath).size <= 1024 * 1024);
      const saved = JSON.parse(readFileSync(replayPath, "utf8"));
      check(
        Array.isArray(saved) &&
          saved.length <= 4096 &&
          saved.every(
            (e) => Array.isArray(e) && e.length === 2 && id(e[0]) && Number.isSafeInteger(e[1]),
          ),
      );
      nonces = new Map(saved);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  function persist() {
    const temp = `${replayPath}.${randomUUID()}.tmp`,
      handle = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    try {
      writeFileSync(handle, JSON.stringify([...nonces]));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, replayPath);
    const dir = openSync(config.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  function verifyTicket(value, path = "/projects/discover") {
    check(
      exact(value, ["ticket"]) &&
        typeof value.ticket === "string" &&
        value.ticket.length <= (path === "/projects/tasks/start" ? 98304 : 16384),
    );
    const parts = value.ticket.split(".");
    check(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
    const header = JSON.parse(Buffer.from(parts[0], "base64url"));
    check(
      exact(header, ["alg", "typ", "kid"]) &&
        header.alg === "EdDSA" &&
        header.typ === "JWT" &&
        header.kid === config.issuerKeyId &&
        verify(
          null,
          Buffer.from(`${parts[0]}.${parts[1]}`),
          key,
          Buffer.from(parts[2], "base64url"),
        ),
    );
    const c = JSON.parse(Buffer.from(parts[1], "base64url")),
      now = Math.floor(Date.now() / 1000);
    check(
      exact(c, ["iss", "aud", "scope", "jti", "iat", "exp", "binding", "request"]) &&
        c.iss === config.hiveOrigin &&
        c.aud === config.binding.appOrigin &&
        Object.hasOwn(projectScopes, path) &&
        c.scope === projectScopes[path] &&
        id(c.jti) &&
        Number.isSafeInteger(c.iat) &&
        c.iat <= now &&
        Number.isSafeInteger(c.exp) &&
        c.exp > now &&
        c.exp - c.iat > 0 &&
        c.exp - c.iat <= 60,
    );
    check(
      exact(c.binding, bindingKeys) && bindingKeys.every((k) => c.binding[k] === config.binding[k]),
    );
    const r = c.request;
    validateProjectOperation(path, r);
    nonces = new Map([...nonces].filter(([, expiry]) => expiry > now));
    check(nonces.size < 4096 && !nonces.has(c.jti));
    nonces.set(c.jti, c.exp);
    persist();
    return r;
  }
  function runHelper(request) {
    check(!closed);
    check(
      createHash("sha256").update(readFileSync(config.helperPath)).digest("hex") ===
        config.helperSha256,
    );
    const env = Object.fromEntries(
      ["PATH", "HOME", "CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE", "CODER_AGENT_URL"]
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]]),
    );
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/python3", [config.helperPath], {
        env,
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      let size = 0,
        done = false;
      const chunks = [];
      const kill = () => {
        try {
          check(!closed);
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      const fail = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        kill();
        reject(new Error("discovery_unavailable"));
      };
      const timer = setTimeout(fail, 8000);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 524288) return fail();
        chunks.push(chunk);
      });
      child.on("close", (status) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (status === 0) {
            if (request.operation === "resolve") {
              check(
                result.schemaVersion === 1 &&
                  result.providerAccountId === request.expectedAccountId &&
                  result.repository?.providerRepositoryId === request.repositoryId &&
                  /^[a-f0-9]{40}$/.test(result.defaultRevision),
              );
            } else
              check(
                result.schemaVersion === 1 &&
                  result.provider === "github" &&
                  Array.isArray(result.repositories) &&
                  result.repositories.length <= request.perPage &&
                  result.page === request.page &&
                  result.perPage === request.perPage,
              );
            resolve(result);
          } else if (result?.schemaVersion === 1 && helperErrors.has(result.error))
            resolve({ schemaVersion: 1, error: result.error });
          else reject(new Error("discovery_unavailable"));
        } catch {
          reject(new Error("discovery_unavailable"));
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
  async function discover(value) {
    check(!closed && !busy);
    busy = true;
    try {
      return await runHelper(verifyTicket(value)).catch(() => ({
        schemaVersion: 1,
        error: "discovery_unavailable",
      }));
    } finally {
      busy = false;
    }
  }
  async function handleProjects(request, response) {
    check(
      request.method === "POST" &&
        Object.hasOwn(projectScopes, request.url) &&
        request.headers.host === new URL(config.binding.appOrigin).host &&
        request.headers["content-type"]?.split(";")[0] === "application/json" &&
        !request.headers["content-encoding"],
    );
    const limit = request.url === "/projects/tasks/start" ? 98304 : 20000;
    const length = request.headers["content-length"];
    check(!length || (/^\d+$/.test(length) && Number(length) <= limit));
    const timer = setTimeout(() => request.destroy(), 5000),
      chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        check(bytes <= limit);
        chunks.push(chunk);
      }
      clearTimeout(timer);
      const value = JSON.parse(Buffer.concat(chunks).toString());
      const result =
        request.url === "/projects/discover"
          ? await discover(value)
          : await controller?.handle(request.url, verifyTicket(value, request.url));
      check(!closed && result);
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(result));
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    discover,
    async resolveRepository(request) {
      check(
        !closed &&
          !busy &&
          exact(request, ["schemaVersion", "operation", "repositoryId", "expectedAccountId"]) &&
          request.operation === "resolve",
      );
      validateProjectOperation("/projects/resolve", {
        schemaVersion: request.schemaVersion,
        repositoryId: request.repositoryId,
        expectedAccountId: request.expectedAccountId,
      });
      busy = true;
      try {
        return await runHelper(request);
      } finally {
        busy = false;
      }
    },
    handleProjects,
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
/** Pre-project phase uses this listener; after supervisor setup the same handler
 * is passed to startProjectGateway. Never run both listeners on one app port. */
export async function startDiscoveryGateway({ port, appOrigin }, discovery) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535);
  const host = new URL(appOrigin).host;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.host !== host) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === "POST" && Object.hasOwn(projectScopes, request.url)) {
      void discovery.handleProjects(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(403);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
