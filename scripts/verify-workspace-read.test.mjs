import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  createWorkspaceReadService,
  readWorkspaceReadStartup,
  validateWorkspaceReadConfig,
  workspaceReadResponsePayload,
} from "../templates/ai-dev-k8s/scripts/hive-workspace-read.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
function fixture(t, profile = "software") {
  const home = mkdtempSync(join(tmpdir(), "hive-workspace-read-service-")),
    issuer = generateKeyPairSync("ed25519"),
    root = join(home, "projects"),
    sockets = join(home, "sockets"),
    pkg = join(home, "package");
  for (const p of [root, sockets, pkg]) mkdirSync(p, { mode: 0o700 });
  const files = {};
  for (const name of ["hive-workspace-read.mjs", "hive-workspace-read.py"]) {
    copyFileSync(resolve("templates/ai-dev-k8s/scripts", name), join(pkg, name));
    files[name] = sha(readFileSync(join(pkg, name)));
  }
  const raw = JSON.stringify({ schemaVersion: 1, files });
  writeFileSync(join(pkg, "manifest.json"), raw, { mode: 0o600 });
  const config = {
    schemaVersion: 1,
    profile,
    projectsRoot: root,
    home,
    hiveOrigin: "https://hive.invalid",
    issuerKeyId: "read-v1",
    issuerPublicKeyPem: issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
    packageDirectory: pkg,
    manifestSha256: sha(raw),
    stateDirectory: join(home, "state"),
    port: 13342,
    binding: {
      coderOrigin: "https://coder.invalid",
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      buildId: randomUUID(),
      agentId: randomUUID(),
      templateId: randomUUID(),
      appOrigin: "https://hive-read--main--fixture--owner.apps.invalid",
      appId: randomUUID(),
    },
  };
  config.stateDirectory = join(home, ".local/state/hive/workspace-read", config.binding.buildId);
  const services = [];
  const open = () => {
    const value = createWorkspaceReadService(config, { socketDirectory: sockets, listenPort: 0 });
    services.push(value);
    return value;
  };
  const claims = (request, lifetimeId = null, patch = {}) => ({
    iss: config.hiveOrigin,
    aud: config.binding.appOrigin,
    scope: "workspace:read:v1",
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 20,
    lifetimeId,
    profile,
    binding: { ...config.binding, hiveUserId: randomUUID() },
    request,
    ...patch,
  });
  const ticket = (c) => {
    const body = [{ alg: "EdDSA", typ: "JWT", kid: config.issuerKeyId }, c]
      .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
      .join(".");
    return {
      ticket: `${body}.${sign(null, Buffer.from(body), issuer.privateKey).toString("base64url")}`,
    };
  };
  const env = { PATH: "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", TMUX_TMPDIR: sockets };
  t.after(async () => {
    for (const value of services) await value.close();
    const cleanup = spawnSync("/usr/bin/tmux", ["-L", "web", "kill-server"], {
      env,
      encoding: "utf8",
      timeout: 2000,
    });
    if (
      cleanup.status !== 0 &&
      !/no server running|No such file or directory/.test(cleanup.stderr ?? "")
    )
      throw new Error(`Fixture cleanup unresolved; retained ${home}`);
    rmSync(home, { recursive: true, force: true });
  });
  return { home, root, sockets, pkg, config, claims, ticket, open, env };
}
const identity = async (f) => {
  const service = f.open(),
    response = await service.dispatch(f.ticket(f.claims({ operation: "identity" })));
  const { proof, ...body } = response;
  assert(
    verify(
      null,
      Buffer.from(workspaceReadResponsePayload(body)),
      response.result.data.publicKeyPem,
      Buffer.from(proof, "base64url"),
    ),
  );
  return { service, response };
};

test("identity binds the exact installed manifest/config and lifetime, while missing tmux read creates no server", async (t) => {
  const f = fixture(t),
    { service, response } = await identity(f);
  assert.equal(response.result.data.manifestSha256, f.config.manifestSha256);
  assert.equal(response.result.data.configDigest, service.configDigest);
  assert.equal(response.readOnly, true);
  const read = await service.dispatch(
    f.ticket(f.claims({ operation: "sessions" }, response.lifetimeId)),
  );
  assert.deepEqual(read.result, { ok: true, data: { sessions: [], nextCursor: null } });
  await assert.rejects(service.dispatch(f.ticket(f.claims({ operation: "sessions" }, null))));
});
test("signed scope, profile, owner, build, lifetime and unknown command fields cannot select authority", async (t) => {
  const f = fixture(t),
    { service, response } = await identity(f);
  for (const patch of [
    { profile: "browser" },
    { aud: "https://foreign.invalid" },
    { scope: "workspace:exec" },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { binding: { ...f.config.binding, hiveUserId: randomUUID(), buildId: randomUUID() } },
    { binding: { ...f.config.binding, hiveUserId: randomUUID(), ownerId: randomUUID() } },
    { request: { operation: "directory", sessionName: "main", command: "touch /tmp/untrusted" } },
    { request: { operation: "directory", sessionName: "main", socket: "private-native" } },
  ])
    await assert.rejects(
      service.dispatch(f.ticket(f.claims({ operation: "sessions" }, response.lifetimeId, patch))),
    );
  const forged = f.ticket(f.claims({ operation: "identity" }));
  forged.ticket = `${forged.ticket.slice(0, -3)}AAA`;
  await assert.rejects(service.dispatch(forged));
});
test("nonce replay survives restart and a replacement service cannot accept a prior-lifetime read", async (t) => {
  const f = fixture(t),
    first = f.open(),
    c = f.claims({ operation: "identity" }),
    token = f.ticket(c),
    a = await first.dispatch(token),
    stale = f.ticket(f.claims({ operation: "sessions" }, a.lifetimeId));
  await assert.rejects(first.dispatch(token));
  await first.close();
  const next = f.open();
  await assert.rejects(next.dispatch(token));
  const current = await next.dispatch(f.ticket(f.claims({ operation: "identity" })));
  assert.notEqual(current.lifetimeId, a.lifetimeId);
  await assert.rejects(next.dispatch(stale));
});
test("actual fixed HTTP endpoint rejects browser Origin and URL variants before dispatch", async (t) => {
  const f = fixture(t),
    service = f.open(),
    address = await service.listen();
  const post = (path, extra = {}) =>
    new Promise((done, reject) => {
      const body = JSON.stringify(f.ticket(f.claims({ operation: "identity" })));
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method: "POST",
          headers: {
            Host: new URL(f.config.binding.appOrigin).host,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...extra,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () =>
            done({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  for (const [path, extra] of [
    ["/workspace/read?x=1", {}],
    ["/workspace/%72ead", {}],
    ["/workspace/read", { Origin: "" }],
    ["/workspace/read", { Origin: f.config.hiveOrigin }],
  ])
    assert.equal((await post(path, extra)).status, 403);
  const response = await post("/workspace/read");
  assert.equal(response.status, 200);
  assert.equal(response.data.operation, "identity");
  const health = await new Promise((done, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/healthz",
        headers: { Host: new URL(f.config.binding.appOrigin).host },
      },
      (res) => {
        const chunks = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () =>
          done({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, {
    schemaVersion: 1,
    readOnly: true,
    lifetimeId: service.lifetimeId,
    configDigest: service.configDigest,
    manifestSha256: f.config.manifestSha256,
    profile: f.config.profile,
    configFileSha256: null,
  });
});
test("helper tampering cannot advertise an approved identity or produce a positive read", async (t) => {
  const f = fixture(t),
    service = f.open();
  writeFileSync(join(f.pkg, "hive-workspace-read.py"), "raise RuntimeError('tampered')\n");
  await assert.rejects(service.dispatch(f.ticket(f.claims({ operation: "identity" }))));
});

test("fixed installed startup validates exact private bytes, OS context and derived state path", (t) => {
  const f = fixture(t),
    dir = join(f.home, ".config/hive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configPath = join(dir, "workspace-read.json"),
    raw = `${JSON.stringify(f.config)}\n`;
  writeFileSync(configPath, raw, { mode: 0o600 });
  const context = { home: f.home, profile: f.config.profile, packageDirectory: f.pkg };
  assert.equal(readWorkspaceReadStartup(context).configSha256, sha(raw));
  chmodSync(join(f.home, ".config"), 0o2755);
  chmodSync(dir, 0o2755);
  assert.equal(readWorkspaceReadStartup(context).configSha256, sha(raw));
  chmodSync(dir, 0o775);
  assert.throws(() => readWorkspaceReadStartup(context));
  chmodSync(dir, 0o2755);
  assert.throws(() => readWorkspaceReadStartup({ ...context, profile: "browser" }));
  assert.throws(() =>
    validateWorkspaceReadConfig({ ...f.config, stateDirectory: join(f.home, "elsewhere") }),
  );
  assert.throws(() => validateWorkspaceReadConfig({ ...f.config, port: 14444 }));
  assert.throws(() =>
    validateWorkspaceReadConfig({
      ...f.config,
      issuerPublicKeyPem: generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    }),
  );
  assert.throws(() => validateWorkspaceReadConfig({ ...f.config, socketDirectory: f.sockets }));
  chmodSync(configPath, 0o644);
  assert.throws(() => readWorkspaceReadStartup(context));
});
test("fixed CLI rejects arguments before reading primary config or binding its port", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("templates/ai-dev-k8s/scripts/hive-workspace-read.mjs"), "--arbitrary"],
    {
      encoding: "utf8",
      timeout: 2000,
      env: { PATH: "/usr/bin:/bin", HIVE_WORKSPACE_PROFILE: "software" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "workspace_read_startup_failed\n");
});
