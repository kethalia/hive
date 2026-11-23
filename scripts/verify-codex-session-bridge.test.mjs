import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  startBridge,
  validateConfig,
} from "../templates/ai-dev-k8s/scripts/codex-session-bridge.mjs";

const binding = {
  ownerId: "owner",
  workspaceId: "workspace",
  buildId: "build",
  serverInstanceId: "server",
  threadId: "thread",
};
const item = { type: "agentMessage", id: "message", text: "native hello" };
const turn = { id: "turn", status: "completed", itemsView: "full", items: [item] };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hive-bridge-test-"));
  const keys = generateKeyPairSync("ed25519");
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => upstream.once("listening", resolve));
  const calls = [];
  let connections = 0;
  upstream.on("connection", (socket) => {
    connections++;
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      calls.push(message);
      if (message.id === undefined) return;
      if (message.method === "initialize" && overrides.earlyEvent) {
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: binding.threadId,
              turnId: turn.id,
              item: { ...item, text: "EARLY_NATIVE_PRIVATE_EVENT" },
            },
          }),
        );
      }
      const result = {
        initialize: {
          userAgent: `hive_session_bridge/${overrides.version ?? "0.165.0"} (Linux)`,
          codexHome: "/private/path",
          platformFamily: "unix",
          platformOs: "linux",
        },
        "thread/loaded/list": { data: overrides.loaded ?? [binding.threadId], nextCursor: null },
        "thread/resume": {
          thread: { id: binding.threadId },
          instructionSources: ["/private/instructions"],
        },
        "thread/turns/list": { data: overrides.turns ?? [turn], nextCursor: null },
      }[message.method];
      if (result) socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const config = {
    schemaVersion: 1,
    protocolVersion: "0.165.0",
    binding,
    hiveOrigin: "https://hive.example.com",
    appOrigin: "https://bridge--main--workspace--owner.coder.example.com",
    nativeUrl: `ws://127.0.0.1:${upstream.address().port}`,
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyId: "key-1",
    stateDirectory: directory,
    port: 0,
  };
  let bridge = await startBridge(config);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await bridge?.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const ticket = (changes = {}, headerChanges = {}, privateKey = keys.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: config.hiveOrigin,
      aud: config.appOrigin,
      sub: binding.ownerId,
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      serverInstanceId: binding.serverInstanceId,
      threadId: binding.threadId,
      origin: config.hiveOrigin,
      scope: "session:read",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      ...changes,
    };
    const header = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.keyId, ...headerChanges }),
    ).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
  };
  const connect = async (headers = {}, path = "/session", port = bridge?.port) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { origin: config.hiveOrigin, host: new URL(config.appOrigin).host, ...headers },
    });
    clients.push(socket);
    const messages = [];
    const waiters = [];
    socket.on("message", (data) => {
      const value = JSON.parse(data);
      const index = waiters.findIndex((waiter) => waiter.match(value));
      if (index < 0) messages.push(value);
      else {
        const waiter = waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      }
    });
    const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return {
      socket,
      messages,
      closed,
      send: (value) => socket.send(JSON.stringify(value)),
      next: (match = () => true) => {
        const index = messages.findIndex(match);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Expected bridge message timed out")),
            2000,
          );
          waiters.push({ match, resolve, timer });
        });
      },
    };
  };
  const authenticated = async (token) => {
    const client = await connect();
    client.send({ type: "authenticate", ticket: token ?? ticket() });
    assert.equal((await client.next()).type, "authenticated");
    return client;
  };
  const initialized = async () => {
    const client = await authenticated();
    client.send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test", version: "1" } },
    });
    const response = await client.next((value) => value.id === 1);
    assert.equal(response.result.codexHome, undefined);
    client.send({ method: "initialized" });
    return client;
  };
  return {
    config,
    calls,
    ticket,
    connect,
    authenticated,
    initialized,
    upstream,
    connections: () => connections,
    stop: async () => {
      await bridge?.close();
      bridge = undefined;
    },
    restart: async () => {
      await bridge?.close();
      bridge = await startBridge(config);
    },
  };
}

test("signed owner capability reads the exact existing native thread and streams allowed events", async (t) => {
  const f = await fixture(t);
  const client = await f.initialized();
  client.send({
    id: 2,
    method: "thread/resume",
    params: { threadId: binding.threadId, excludeTurns: true },
  });
  assert.deepEqual((await client.next((value) => value.id === 2)).result, {
    thread: { id: binding.threadId },
  });
  client.send({
    id: 3,
    method: "thread/turns/list",
    params: { threadId: binding.threadId, itemsView: "full", sortDirection: "asc", limit: 100 },
  });
  assert.deepEqual((await client.next((value) => value.id === 3)).result.data, [turn]);
  const native = [...f.upstream.clients][0];
  native.send(
    JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "unrelated",
        turnId: "private",
        item: { ...item, text: "private-other-thread" },
      },
    }),
  );
  native.send(
    JSON.stringify({
      method: "item/completed",
      params: { threadId: binding.threadId, turnId: turn.id, item },
    }),
  );
  const event = await client.next((value) => value.method === "item/completed");
  assert.equal(event.params.threadId, binding.threadId);
  assert.equal(
    client.messages.some((value) => JSON.stringify(value).includes("private-other-thread")),
    false,
  );
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["initialize", "initialized", "thread/loaded/list", "thread/resume", "thread/turns/list"],
  );
});

test("wrong owner, host bindings, scope, origin, expiry, and algorithms are rejected before native access", async (t) => {
  const f = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  const candidates = [
    f.ticket({ sub: "other" }),
    f.ticket({ workspaceId: "other" }),
    f.ticket({ buildId: "other" }),
    f.ticket({ serverInstanceId: "other" }),
    f.ticket({ threadId: "other" }),
    f.ticket({ origin: "https://evil.example" }),
    f.ticket({ scope: "session:write" }),
    f.ticket({ exp: now - 1, iat: now - 10 }),
    f.ticket({ exp: now + 61 }),
    f.ticket({}, { alg: "HS256" }),
    f.ticket({}, { kid: "untrusted-key" }),
    f.ticket({}, {}, generateKeyPairSync("ed25519").privateKey),
  ];
  for (const ticket of candidates) {
    const client = await f.connect();
    client.send({ type: "authenticate", ticket });
    assert.equal(await client.closed, 1008);
  }
  assert.equal(f.connections(), 0);
});

test("Origin, Host, URL query credentials, and forged Coder headers do not grant access", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.connect({ origin: "https://evil.example" }));
  await assert.rejects(f.connect({ host: "evil.example" }));
  await assert.rejects(f.connect({}, "/session?ticket=secret"));
  const client = await f.connect({
    "x-coder-user": "owner",
    "coder-session-token": "not-an-authority",
  });
  client.send({ id: 1, method: "initialize", params: {} });
  assert.equal(await client.closed, 1008);
  assert.equal(f.connections(), 0);
});

test("ticket replay remains rejected after a bridge restart", async (t) => {
  const f = await fixture(t);
  const ticket = f.ticket();
  const first = await f.authenticated(ticket);
  first.socket.terminate();
  await f.restart();
  const second = await f.connect();
  second.send({ type: "authenticate", ticket });
  assert.equal(await second.closed, 1008);
  assert.equal(f.connections(), 1);
});

test("active sockets close at ticket expiry", async (t) => {
  const f = await fixture(t);
  const client = await f.authenticated(f.ticket({ exp: Math.floor(Date.now() / 1000) + 2 }));
  assert.equal(await client.closed, 1008);
});

test("fresh renewal extends one socket and native connection, with replay rejected", async (t) => {
  const f = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  const oldExpiry = now + 2;
  const client = await f.authenticated(f.ticket({ exp: oldExpiry }));
  const renewal = f.ticket({ exp: now + 3 });
  client.send({ type: "renew", ticket: renewal });
  assert.deepEqual(await client.next(), { type: "renewed", expiresAt: now + 3 });
  client.send({ type: "renew", ticket: renewal });
  assert.deepEqual(await client.next(), { type: "renewalRejected" });
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, oldExpiry * 1000 - Date.now() + 100)),
  );
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  assert.equal(f.connections(), 1);
  assert.equal(await client.closed, 1008);
});

test("a changed-binding renewal cannot extend the old capability deadline", async (t) => {
  const f = await fixture(t);
  const client = await f.authenticated(f.ticket({ exp: Math.floor(Date.now() / 1000) + 2 }));
  client.send({ type: "renew", ticket: f.ticket({ threadId: "other" }) });
  assert.deepEqual(await client.next(), { type: "renewalRejected" });
  assert.equal(await client.closed, 1008);
  assert.equal(f.connections(), 1);
});

test("execution, model overrides, arbitrary threads, and server request responses are rejected", async (t) => {
  const f = await fixture(t);
  for (const request of [
    { id: 2, method: "thread/shellCommand", params: { threadId: "thread", command: "do-not-run" } },
    { id: 2, method: "thread/start", params: {} },
    { id: 2, method: "turn/start", params: { threadId: "thread", input: [] } },
    {
      id: 2,
      method: "thread/resume",
      params: { threadId: "thread", excludeTurns: true, model: "other" },
    },
    { id: 2, method: "thread/resume", params: { threadId: "other", excludeTurns: true } },
    { id: "native-request", result: { decision: "accept" } },
  ]) {
    const client = await f.initialized();
    client.send(request);
    assert.equal(await client.closed, 1008);
  }
  assert.ok(f.calls.every((call) => ["initialize", "initialized"].includes(call.method)));
});

test("an unloaded thread is not resumed and unsupported native versions fail closed", async (t) => {
  const f = await fixture(t, { loaded: [] });
  const client = await f.initialized();
  client.send({
    id: 2,
    method: "thread/resume",
    params: { threadId: "thread", excludeTurns: true },
  });
  assert.equal((await client.next((value) => value.id === 2)).error.code, -32000);
  assert.equal(
    f.calls.some((call) => call.method === "thread/resume"),
    false,
  );
  const old = await fixture(t, { version: "0.164.0" });
  const rejected = await old.connect();
  rejected.send({ type: "authenticate", ticket: old.ticket() });
  assert.equal(await rejected.closed, 1008);
});

test("duplicate IDs, malformed and oversized frames are bounded", async (t) => {
  const f = await fixture(t);
  const duplicate = await f.initialized();
  duplicate.send({ id: 1, method: "initialize", params: { clientInfo: {} } });
  assert.equal(await duplicate.closed, 1008);
  const malformed = await f.connect();
  malformed.socket.send("{");
  assert.equal(await malformed.closed, 1008);
  const oversized = await f.connect();
  oversized.socket.send("a".repeat(1024 * 1024 + 1));
  assert.equal(await oversized.closed, 1009);
});

test("hidden reasoning and unsupported tool payloads never reach a read client", async (t) => {
  const f = await fixture(t, {
    turns: [
      {
        ...turn,
        items: [
          { id: "reason", type: "reasoning", content: ["hidden"], summary: [] },
          { id: "tool", type: "mcpToolCall", arguments: { secret: "private" } },
        ],
      },
    ],
  });
  const client = await f.initialized();
  client.send({
    id: 2,
    method: "thread/resume",
    params: { threadId: "thread", excludeTurns: true },
  });
  await client.next((value) => value.id === 2);
  client.send({
    id: 3,
    method: "thread/turns/list",
    params: { threadId: "thread", itemsView: "full", sortDirection: "asc", limit: 100 },
  });
  const result = (await client.next((value) => value.id === 3)).result;
  assert.deepEqual(result.data[0].items, [
    { id: "reason", type: "reasoning" },
    { id: "tool", type: "mcpToolCall" },
  ]);
});

test("configuration rejects public native endpoints, unsupported versions, and concurrent state owners", async (t) => {
  const f = await fixture(t);
  assert.throws(() => validateConfig({ ...f.config, nativeUrl: "ws://0.0.0.0:4500" }));
  assert.throws(() => validateConfig({ ...f.config, protocolVersion: "latest" }));
  assert.throws(() => validateConfig({ ...f.config, hiveOrigin: "https://*.example.com/" }));
  assert.throws(() => validateConfig({ ...f.config, hiveOrigin: "https://*.example.com" }));
  await assert.rejects(startBridge(f.config), /lock unavailable/);
  await assert.rejects(
    startBridge({
      ...f.config,
      binding: Object.fromEntries(Object.entries(f.config.binding).reverse()),
    }),
    /lock unavailable/,
  );
});

test("an incompatible native server cannot leak events before its version check", async (t) => {
  const f = await fixture(t, { version: "0.164.0", earlyEvent: true });
  const client = await f.connect();
  client.send({ type: "authenticate", ticket: f.ticket() });
  assert.equal(await client.closed, 1008);
  assert.deepEqual(client.messages, []);
});

test("SIGKILL releases the OS lock while preserving replay rejection on automatic restart", {
  timeout: 10000,
}, async (t) => {
  const f = await fixture(t);
  await f.stop();
  const configPath = join(f.config.stateDirectory, "bridge-config.json");
  await writeFile(configPath, JSON.stringify(f.config), { mode: 0o600 });
  const script = fileURLToPath(
    new URL("../templates/ai-dev-k8s/scripts/codex-session-bridge.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [script, configPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Child bridge startup timed out")), 3000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  await assert.rejects(startBridge(f.config), /lock unavailable/);
  const ticket = f.ticket();
  const beforeCrash = await f.connect({}, "/session", port);
  beforeCrash.send({ type: "authenticate", ticket });
  assert.equal((await beforeCrash.next()).type, "authenticated");
  child.kill("SIGKILL");
  await exited;
  // No stale-PID inspection, inode deletion, or manual recovery step.
  await f.restart();
  const afterCrash = await f.connect();
  afterCrash.send({ type: "authenticate", ticket });
  assert.equal(await afterCrash.closed, 1008);
  const fresh = await f.authenticated();
  assert.equal(fresh.socket.readyState, WebSocket.OPEN);
});

test("native 0.165 CLI and capability client share one loaded thread without inference", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 15000,
}, async (t) => {
  assert.equal(
    execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    "codex-cli 0.165.0",
  );
  const directory = await mkdtemp(join(tmpdir(), "hive-native-bridge-test-"));
  const home = join(directory, "codex");
  const project = join(directory, "project");
  await mkdir(home);
  await mkdir(project);
  await writeFile(
    join(home, "config.toml"),
    `model = "gpt-6.1-sol"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.probe]
name = "No inference"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
apps = false
plugins = false
memories = false
`,
  );
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const nativeUrl = `ws://127.0.0.1:${reservation.address().port}`;
  await new Promise((resolve) => reservation.close(resolve));
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "SHELL", "LANG"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, { CODEX_HOME: home, TERM: "xterm-256color" });
  const native = spawn("codex", ["app-server", "--listen", nativeUrl], {
    env,
    cwd: project,
    stdio: "ignore",
  });
  const tmuxSocket = join(directory, "tmux.sock");
  const tmux = (args) =>
    execFileSync("tmux", ["-S", tmuxSocket, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let bridge;
  const sockets = [];
  t.after(async () => {
    try {
      tmux(["kill-server"]);
    } catch {}
    for (const socket of sockets) socket.terminate();
    if (bridge) await bridge.close();
    native.kill("SIGTERM");
    await pause(100);
    if (native.exitCode === null) native.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  async function rpc(url, options = {}) {
    const socket = new WebSocket(url, options);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let id = 0;
    const pending = new Map();
    const events = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else events.push(message);
    });
    return {
      socket,
      events,
      call: (method, params) =>
        new Promise((resolve, reject) => {
          const requestId = ++id;
          const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 3000);
          pending.set(requestId, { resolve, reject, timer });
          socket.send(JSON.stringify({ id: requestId, method, params }));
        }),
    };
  }
  async function until(check) {
    for (let i = 0; i < 50; i++) {
      if (check()) return;
      await pause(100);
    }
    throw new Error("Native bridge assertion timed out");
  }
  await pause(800);
  const owner = await rpc(nativeUrl);
  await owner.call("initialize", {
    clientInfo: { name: "hive_native_bridge_test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  owner.socket.send(JSON.stringify({ method: "initialized" }));
  const started = await owner.call("thread/start", { cwd: project, historyMode: "paginated" });
  const threadId = started.thread.id;
  await owner.call("thread/shellCommand", {
    threadId,
    command: "printf 'HIVE_BRIDGE_SEED\\n'",
    timeoutMs: 1000,
  });
  await until(() => owner.events.some((event) => event.method === "turn/completed"));
  const keys = generateKeyPairSync("ed25519");
  const hostBinding = { ...binding, threadId };
  const config = {
    schemaVersion: 1,
    protocolVersion: "0.165.0",
    binding: hostBinding,
    hiveOrigin: "https://hive.example.com",
    appOrigin: "https://bridge.coder.example.com",
    nativeUrl,
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyId: "test",
    stateDirectory: directory,
    port: 0,
  };
  bridge = await startBridge(config);
  tmux([
    "new-session",
    "-d",
    "-s",
    "probe",
    "-x",
    "140",
    "-y",
    "50",
    "-c",
    project,
    "codex",
    "resume",
    "--remote",
    nativeUrl,
    threadId,
    "--no-alt-screen",
  ]);
  await pause(1200);
  const client = await rpc(`ws://127.0.0.1:${bridge.port}/session`, {
    headers: { origin: config.hiveOrigin, host: new URL(config.appOrigin).host },
  });
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "test" })).toString(
    "base64url",
  );
  const claims = Buffer.from(
    JSON.stringify({
      iss: config.hiveOrigin,
      aud: config.appOrigin,
      sub: hostBinding.ownerId,
      workspaceId: hostBinding.workspaceId,
      buildId: hostBinding.buildId,
      serverInstanceId: hostBinding.serverInstanceId,
      threadId,
      origin: config.hiveOrigin,
      scope: "session:read",
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    }),
  ).toString("base64url");
  const ticket = `${header}.${claims}.${sign(null, Buffer.from(`${header}.${claims}`), keys.privateKey).toString("base64url")}`;
  client.socket.send(JSON.stringify({ type: "authenticate", ticket }));
  await until(() => client.events.some((event) => event.type === "authenticated"));
  await client.call("initialize", { clientInfo: { name: "hive_web_test", version: "1" } });
  client.socket.send(JSON.stringify({ method: "initialized" }));
  await client.call("thread/resume", { threadId, excludeTurns: true });
  await owner.call("thread/shellCommand", {
    threadId,
    command: "printf 'HIVE_BRIDGE_LIVE\\n'",
    timeoutMs: 1000,
  });
  await until(() => client.events.some((event) => event.method === "turn/completed"));
  await until(() =>
    tmux(["capture-pane", "-p", "-S", "-200", "-t", "probe"]).includes("HIVE_BRIDGE_LIVE"),
  );
  const history = await client.call("thread/turns/list", {
    threadId,
    itemsView: "full",
    sortDirection: "asc",
    limit: 100,
  });
  assert.ok(JSON.stringify(history).includes("HIVE_BRIDGE_LIVE"));
  assert.deepEqual((await owner.call("thread/loaded/list", {})).data, [threadId]);
  assert.equal(history.data.length, 2);
});
