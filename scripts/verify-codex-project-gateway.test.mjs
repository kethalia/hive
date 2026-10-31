import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startProjectGateway } from "../templates/ai-dev-k8s/scripts/codex-project-gateway.mjs";
import { openSupervisor } from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

function makeTicket(config, binding, privateKey, ttl = 30) {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.keyId }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
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
      exp: now + ttl,
      jti: randomUUID(),
    }),
  ).toString("base64url");
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}
async function gatewayClient(port, config, ticket) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`, {
    headers: { Origin: config.hiveOrigin, Host: new URL(config.appOrigin).host },
  });
  const messages = [];
  let code;
  let next = 1;
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  ws.on("close", (value) => {
    code = value;
  });
  ws.on("error", () => {});
  const until = async (predicate) => {
    for (let i = 0; i < 300; i++) {
      const result = predicate();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("gateway_fixture_timeout");
  };
  await until(() => ws.readyState === WebSocket.OPEN);
  ws.send(JSON.stringify({ type: "authenticate", ticket }));
  const rpc = async (method, params) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return until(() => messages.find((m) => m.id === id));
  };
  return {
    ws,
    messages,
    until,
    closed: () => code,
    rpc,
    async ready(threadId) {
      await until(() => messages.find((m) => m.type === "authenticated"));
      await rpc("initialize", { clientInfo: { name: "fixture" } });
      ws.send(JSON.stringify({ method: "initialized" }));
      return rpc("thread/resume", { threadId, excludeTurns: true });
    },
  };
}
async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "hive-gateway-test-"));
  const keys = generateKeyPairSync("ed25519");
  const token = randomUUID();
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => upstream.once("listening", r));
  const calls = [];
  let connections = 0;
  const threads = new Map();
  let live = true;
  let onClose = () => {};
  upstream.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    connections++;
    socket.on("message", (data) => {
      const message = JSON.parse(data);
      calls.push(message);
      if (message.id === undefined) return;
      const thread = threads.get(message.params?.threadId);
      const result = {
        initialize: { userAgent: "hive/0.165.0" },
        "thread/loaded/list": { data: [...threads.keys()], nextCursor: null },
        "thread/resume": { thread: { id: message.params?.threadId } },
        "thread/turns/list": {
          data: [
            {
              id: "turn",
              status: "completed",
              items: [{ type: "agentMessage", id: "message", text: `history-${thread?.project}` }],
            },
          ],
          nextCursor: null,
        },
      }[message.method];
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const c = {
    schemaVersion: 1,
    profile: "software",
    ownerId: "owner",
    workspaceId: "workspace",
    buildId: "build",
    codexExecutable: "/fixture/native",
    codexSha256: "a".repeat(64),
    projects: ["one", "two"].map((projectId, index) => ({
      projectId,
      repositoryId: String(index + 1),
      taskId: projectId,
      leaseId: `lease-${projectId}`,
      leaseGeneration: 1,
      model: "gpt-6.1-sol",
      effort: "low",
    })),
  };
  for (const p of c.projects)
    mkdirSync(join(home, "projects/.hive-managed/github", p.repositoryId, "checkout"), {
      recursive: true,
    });
  const runtime = {
    version: "0.165.0",
    alive: () => live,
    onClose: (fn) => {
      onClose = fn;
    },
    close: async () => {
      live = false;
      onClose();
    },
    createReadSocket: () =>
      new WebSocket(`ws://127.0.0.1:${upstream.address().port}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    inspectLease: (p) => ({
      ok: true,
      data: {
        status: "ready",
        checkoutVerified: true,
        checkoutDirectory: join(home, "projects/.hive-managed/github", p.repositoryId, "checkout"),
        lease: {
          id: p.leaseId,
          taskId: p.taskId,
          generation: 1,
          expiresAt: Date.now() / 1000 + 900,
        },
      },
    }),
    async call(method, params) {
      if (method === "thread/start") {
        const p = c.projects.find((p) => params.cwd.includes(`/github/${p.repositoryId}/`));
        const id = `thread-${p.projectId}`;
        threads.set(id, { project: p.projectId });
        return { thread: { id, cwd: params.cwd }, model: p.model, reasoningEffort: p.effort };
      }
      if (method === "turn/start") return { turn: { id: "turn" } };
      return { data: [{ id: "turn" }] };
    },
  };
  const supervisor = await openSupervisor(c, { home, runtimeFactory: async () => runtime });
  for (const p of c.projects) {
    await supervisor.command({
      operation: "ensureProject",
      projectId: p.projectId,
      creationIntentId: `intent-${p.projectId}`,
    });
    await supervisor.command({
      operation: "firstPrompt",
      projectId: p.projectId,
      requestId: `input-${p.projectId}`,
      text: "fixture input",
    });
  }
  const stateDirectory = join(home, "gateway");
  mkdirSync(stateDirectory, { mode: 0o700 });
  const config = {
    schemaVersion: 1,
    protocolVersion: "0.165.0",
    hiveOrigin: "https://hive.example.com",
    appOrigin: "https://session.coder.example.com",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyId: "issuer",
    stateDirectory,
    port: 0,
  };
  const gateway = await startProjectGateway(config, supervisor);
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.ws.terminate();
    await gateway.close();
    await supervisor.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((r) => upstream.close(r));
    rmSync(home, { recursive: true, force: true });
  });
  return {
    supervisor,
    gateway,
    config,
    calls,
    upstream,
    connections: () => connections,
    home,
    async client(project = "one", changes = {}, ttl = 30) {
      const c = await gatewayClient(
        gateway.port,
        config,
        makeTicket(config, { ...supervisor.binding(project), ...changes }, keys.privateKey, ttl),
      );
      clients.push(c);
      return c;
    },
    ticket: (project, ttl = 60) =>
      makeTicket(config, supervisor.binding(project), keys.privateKey, ttl),
  };
}

test("one gateway routes registered threads with isolated histories/events and private native auth", async (t) => {
  const f = await fixture(t);
  const a = await f.client();
  await a.ready("thread-one");
  const b = await f.client("two");
  await b.ready("thread-two");
  assert.match(
    JSON.stringify(
      await a.rpc("thread/turns/list", {
        threadId: "thread-one",
        limit: 10,
        sortDirection: "asc",
        itemsView: "full",
      }),
    ),
    /history-one/,
  );
  for (const socket of f.upstream.clients)
    for (const name of ["one", "two"])
      socket.send(
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: {
            threadId: `thread-${name}`,
            turnId: "turn",
            itemId: "message",
            delta: `only-${name}`,
          },
        }),
      );
  await a.until(() => JSON.stringify(a.messages).includes("only-one"));
  await b.until(() => JSON.stringify(b.messages).includes("only-two"));
  assert.ok(!JSON.stringify(a.messages).includes("only-two"));
  assert.ok(!JSON.stringify(b.messages).includes("only-one"));
  assert.equal(f.connections(), 2);
  a.ws.send(JSON.stringify({ type: "renew", ticket: f.ticket("two") }));
  await a.until(() => a.messages.find((m) => m.type === "renewalRejected"));
  assert.equal(f.connections(), 2);
  rmSync(join(f.home, "projects/.hive-managed/github/1/checkout"), { recursive: true });
  assert.match(
    JSON.stringify(
      await a.rpc("thread/turns/list", {
        threadId: "thread-one",
        limit: 10,
        sortDirection: "asc",
        itemsView: "full",
      }),
    ),
    /history-one/,
  );
  f.supervisor.revoke();
  await a.until(() => a.closed());
  assert.equal(a.closed(), 1008);
});
test("unknown threads and wrong owners are denied before native connect; execution remains forbidden", async (t) => {
  const f = await fixture(t);
  for (const changes of [{ threadId: "unknown" }, { ownerId: "other" }]) {
    const client = await f.client("one", changes);
    await client.until(() => client.closed());
    assert.equal(client.closed(), 1008);
  }
  assert.equal(f.connections(), 0);
  for (const method of ["turn/start", "thread/start", "thread/shellCommand"]) {
    const client = await f.client();
    await client.ready("thread-one");
    client.ws.send(JSON.stringify({ id: 99, method, params: { threadId: "thread-one" } }));
    await client.until(() => client.closed());
    assert.equal(client.closed(), 1008);
    assert.ok(!f.calls.some((c) => c.method === method));
  }
  const client = await f.client();
  await client.ready("thread-one");
  client.ws.send(
    JSON.stringify({
      id: 99,
      method: "thread/turns/list",
      params: { threadId: "thread-two", limit: 10, sortDirection: "asc", itemsView: "full" },
    }),
  );
  await client.until(() => client.closed());
  assert.equal(client.closed(), 1008);
});
