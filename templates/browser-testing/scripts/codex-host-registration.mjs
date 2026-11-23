// Installed supervisor integration only. No CLI, HTTP listener, or startup side effect.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

const check = (v) => {
  if (!v) throw new Error("registration_rejected");
};
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const id = (v) => typeof v === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
/** Config is independently installed alongside supervisor identity. It is never
 * accepted from an HTTP request, grant, repository file, app header, or model. */
export function createHostRegistration(supervisor, config, fetchController = fetch) {
  check(
    exact(config, [
      "hiveOrigin",
      "coderOrigin",
      "hiveUserId",
      "agentId",
      "templateId",
      "appId",
      "appOrigin",
      "issuerPublicKeyPem",
      "issuerKeyId",
    ]),
  );
  for (const key of ["hiveOrigin", "coderOrigin", "appOrigin"]) {
    const u = new URL(config[key]);
    check(u.protocol === "https:" && u.origin === config[key] && !u.username && !u.password);
  }
  for (const key of ["hiveUserId", "agentId", "templateId", "appId", "issuerKeyId"])
    check(id(config[key]));
  const issuer = createPublicKey(config.issuerPublicKeyPem);
  check(issuer.asymmetricKeyType === "ed25519");
  if (!supervisor.state.controllerPrivateKeyPem) {
    supervisor.state.controllerPrivateKeyPem = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    supervisor.save();
  }
  const key = createPrivateKey(supervisor.state.controllerPrivateKeyPem);
  check(key.asymmetricKeyType === "ed25519");
  const publicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
  const listeners = new Set();
  let active = null,
    registeredThreads = [],
    expiryTimer,
    heartbeatTimer,
    busy = false,
    closed = false;
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };
  function expire() {
    clearTimeout(expiryTimer);
    clearTimeout(heartbeatTimer);
    active = null;
    registeredThreads = [];
    notify();
  }
  function isActive() {
    return (
      !closed &&
      active &&
      active.expiresAt * 1000 > Date.now() &&
      supervisor.runtime.alive() &&
      supervisor.state.status === "ready"
    );
  }
  async function post(path, body, deadline = Date.now() + 5000) {
    check(deadline > Date.now());
    let response;
    try {
      response = await fetchController(config.hiveOrigin + path, {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error("controller_transport_unavailable"), { retryable: true });
    }
    try {
      let headerSize = 0;
      response.headers.forEach((v, k) => {
        headerSize += v.length + k.length;
      });
      check(headerSize <= 16384 && response.status === 200);
      const reader = response.body?.getReader();
      check(reader);
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          let r;
          try {
            r = await reader.read();
          } catch {
            throw Object.assign(new Error("controller_transport_unavailable"), { retryable: true });
          }
          if (r.done) break;
          size += r.value.length;
          check(size <= 4096);
          chunks.push(r.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString());
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  function accept(result, previous) {
    check(
      exact(result, ["registrationId", "expiresAt", "sequence", "nonce"]) &&
        id(result.registrationId) &&
        id(result.nonce) &&
        Number.isSafeInteger(result.expiresAt) &&
        result.expiresAt * 1000 > Date.now() &&
        result.expiresAt * 1000 <= Date.now() + 60000 &&
        Number.isSafeInteger(result.sequence) &&
        result.sequence >= 0,
    );
    if (previous)
      check(
        result.registrationId === previous.registrationId &&
          result.sequence === previous.sequence + 1 &&
          result.nonce !== previous.nonce,
      );
    active = result;
    clearTimeout(expiryTimer);
    clearTimeout(heartbeatTimer);
    expiryTimer = setTimeout(expire, Math.max(1, result.expiresAt * 1000 - Date.now()));
    heartbeatTimer = setTimeout(
      () => void heartbeat(),
      Math.min(20000, Math.max(1, result.expiresAt * 1000 - Date.now() - 5000)),
    );
  }
  async function heartbeat() {
    if (!isActive()) return expire();
    const prior = active;
    const body = {
      registrationId: prior.registrationId,
      serverInstanceId: supervisor.state.serverInstanceId,
      sequence: prior.sequence + 1,
      nonce: prior.nonce,
    };
    body.proof = sign(
      null,
      Buffer.from(`hive-host-heartbeat-v1\n${JSON.stringify(body)}`),
      key,
    ).toString("base64url");
    // One identical retry recovers a server-committed acknowledgement lost in
    // transit. Policy failures never retry; neither attempt can pass old expiry.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await post(
          `/api/codex-host/registrations/${prior.registrationId}/heartbeat`,
          body,
          prior.expiresAt * 1000,
        );
        if (active === prior && !closed) accept(result, prior);
        return;
      } catch (error) {
        if (
          attempt === 0 &&
          error?.retryable === true &&
          active === prior &&
          isActive() &&
          prior.expiresAt * 1000 - Date.now() > 1000
        )
          continue;
        if (active === prior) expire();
        return;
      }
    }
  }

  async function bootstrap(value) {
    check(!closed && !busy && supervisor.runtime.alive() && supervisor.state.status === "ready");
    busy = true;
    try {
      check(
        exact(value, ["grant"]) && typeof value.grant === "string" && value.grant.length <= 16384,
      );
      const parts = value.grant.split(".");
      check(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
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
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()),
        now = Math.floor(Date.now() / 1000);
      check(
        exact(claims, ["iss", "aud", "scope", "jti", "iat", "exp", "generation", "binding"]) &&
          claims.iss === config.hiveOrigin &&
          claims.aud === "hive:workspace-registration" &&
          claims.scope === "workspace:register" &&
          id(claims.jti) &&
          Number.isSafeInteger(claims.iat) &&
          claims.iat <= now &&
          Number.isSafeInteger(claims.exp) &&
          claims.exp > now &&
          claims.exp - claims.iat > 0 &&
          claims.exp - claims.iat <= 60 &&
          Number.isSafeInteger(claims.generation) &&
          claims.generation > 0,
      );
      const b = claims.binding;
      check(
        exact(b, [
          "coderOrigin",
          "hiveUserId",
          "ownerId",
          "workspaceId",
          "buildId",
          "agentId",
          "templateId",
          "appOrigin",
          "appId",
          "projects",
        ]),
      );
      for (const field of [
        "coderOrigin",
        "hiveUserId",
        "agentId",
        "templateId",
        "appOrigin",
        "appId",
      ])
        check(b[field] === config[field]);
      for (const field of ["ownerId", "workspaceId", "buildId"])
        check(b[field] === supervisor.config[field]);
      check(
        Array.isArray(b.projects) &&
          b.projects.length > 0 &&
          b.projects.length <= 32 &&
          new Set(b.projects.map((p) => p.projectId)).size === b.projects.length,
      );
      const threads = [];
      for (const project of b.projects) {
        check(
          exact(project, ["projectId", "repositoryId"]) &&
            id(project.projectId) &&
            /^[1-9][0-9]{0,19}$/.test(project.repositoryId),
        );
        const installed = supervisor.config.projects.find(
          (p) => p.projectId === project.projectId && p.repositoryId === project.repositoryId,
        );
        if (!installed) continue;
        const binding = supervisor.registrationBinding(project.projectId);
        threads.push({ ...project, threadId: binding.threadId });
      }
      check(threads.length > 0);
      const slot = hash(
        JSON.stringify([
          config.coderOrigin,
          config.hiveUserId,
          supervisor.config.workspaceId,
          config.agentId,
        ]),
      );
      const prior = supervisor.state.controllerRegistration;
      check(!prior || prior.slot !== slot || claims.generation > prior.generation);
      // Burn generation durably BEFORE the request. Crash/rejection requires a fresh
      // controller grant; never retry an ambiguous one-use registration automatically.
      supervisor.state.controllerRegistration = {
        slot,
        generation: claims.generation,
        grantId: claims.jti,
        status: "pending",
      };
      supervisor.save();
      expire();
      const request = {
        grant: value.grant,
        serverInstanceId: supervisor.state.serverInstanceId,
        protocolVersion: "0.165.0",
        threads,
        hostPublicKeyPem: publicKey,
      };
      request.proof = sign(
        null,
        Buffer.from(
          `hive-registration-v1\n${hash(value.grant)}\n${JSON.stringify({ serverInstanceId: request.serverInstanceId, protocolVersion: request.protocolVersion, threads, hostPublicKeyPem: publicKey })}`,
        ),
        key,
      ).toString("base64url");
      const result = await post("/api/codex-host/registrations", request);
      check(!closed && supervisor.runtime.alive());
      accept(result);
      registeredThreads = threads.map((t) => ({ projectId: t.projectId, threadId: t.threadId }));
      supervisor.state.controllerRegistration.status = "registered";
      supervisor.save();
      return { registrationId: active.registrationId, expiresAt: active.expiresAt };
    } finally {
      busy = false;
    }
  }
  async function handleBootstrap(request, response) {
    check(
      request.method === "POST" &&
        request.url === "/registration/bootstrap" &&
        request.headers.host === new URL(config.appOrigin).host,
    );
    check(
      request.headers["content-type"]?.split(";")[0] === "application/json" &&
        !request.headers["content-encoding"],
    );
    const length = request.headers["content-length"];
    check(!length || (/^\d+$/.test(length) && Number(length) <= 20000));
    const timer = setTimeout(() => request.destroy(), 5000);
    let bytes = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        check(bytes <= 20000);
        chunks.push(chunk);
      }
      const result = await bootstrap(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(result));
    } finally {
      clearTimeout(timer);
    }
  }
  const unsubscribe = supervisor.onRevoked(expire);
  return {
    bootstrap,
    currentRegistration: () =>
      isActive()
        ? {
            id: active.registrationId,
            serverInstanceId: supervisor.state.serverInstanceId,
            expiresAt: active.expiresAt * 1000,
            threads: registeredThreads.map((t) => ({ ...t })),
          }
        : null,
    handleBootstrap,
    isActive,
    heartbeat,
    onRevoked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      expire();
      unsubscribe();
    },
  };
}
