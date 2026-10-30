import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createVoiceHost, voiceConfigDigest } from "./voice-host.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const config = {
  issuerPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  issuerKeyId: "test",
  issuer: "https://hive.example",
  audience: "https://voice.example",
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  agentId: randomUUID(),
  lockDirectory: "/tmp",
  manifestSha256: "a".repeat(64),
};
function ticket(overrides = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: "test" };
  const claims = {
    iss: config.issuer,
    aud: config.audience,
    scope: "voice:connect:v1",
    jti: randomUUID(),
    iat,
    exp: iat + 15,
    workspaceId: config.workspaceId,
    buildId: config.buildId,
    agentId: config.agentId,
    threadId: randomUUID(),
    lifetimeId: null,
    ...overrides,
  };
  const text = [header, claims]
    .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
    .join(".");
  return `${text}.${sign(null, Buffer.from(text), privateKey).toString("base64url")}`;
}
const fixture = `
const { WebSocketServer } = require("ws");
const { Duplex } = require("node:stream");
const http = require("node:http");
const server = http.createServer();
const ws = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head, client => client.on("message", raw => { const request = JSON.parse(raw.toString()); client.send(JSON.stringify({id: request.id, result: request.params})); })));
server.emit("connection", Duplex.from({ readable: process.stdin, writable: process.stdout }));
`;
async function connect(url, token) {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await once(socket, "open");
  return socket;
}
async function identity(url, expectedConfig = config) {
  const response = await fetch(`${url.replace(/^ws/, "http")}/identity`, {
    headers: { Authorization: `Bearer ${ticket({ scope: "voice:identity:v1", threadId: null })}` },
  });
  assert.equal(response.status, 200);
  const { proof, ...body } = await response.json();
  assert.equal(body.manifestSha256, config.manifestSha256);
  assert.equal(body.configDigest, voiceConfigDigest(expectedConfig));
  assert.ok(
    verify(
      null,
      Buffer.from(`hive-voice-identity-v1\n${JSON.stringify(body)}`),
      body.publicKeyPem,
      Buffer.from(proof, "base64url"),
    ),
  );
  return body.lifetimeId;
}
test("host authorizes a one-use bound ticket and relays framed RPC", async (t) => {
  const host = createVoiceHost(config, {
    spawn: () => spawn(process.execPath, ["-e", fixture], { stdio: ["pipe", "pipe", "pipe"] }),
  });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  t.after(() => host.close());
  const url = `ws://127.0.0.1:${host.server.address().port}/voice`,
    lifetimeId = await identity(url),
    auth = ticket({ lifetimeId });
  const socket = await connect(url, auth);
  socket.send(JSON.stringify({ id: 1, method: "initialize", params: { hello: "world" } }));
  assert.deepEqual(JSON.parse((await once(socket, "message"))[0].toString()), {
    id: 1,
    result: { hello: "world" },
  });
  const replay = new WebSocket(url, { headers: { Authorization: `Bearer ${auth}` } });
  await assert.rejects(once(replay, "open"));
  const wrong = new WebSocket(url, {
    headers: { Authorization: `Bearer ${ticket({ buildId: randomUUID(), lifetimeId })}` },
  });
  await assert.rejects(once(wrong, "open"));
  socket.send(JSON.stringify({ id: 2, method: "exec", params: {} }));
  await once(socket, "close");
});

test("thread lock excludes another voice proxy until the first closes", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const lockDirectory = await mkdtemp(join(tmpdir(), "voice-lock-"));
  const host = createVoiceHost(
    { ...config, lockDirectory },
    {
      spawn: (_command, args) =>
        spawn("flock", [...args.slice(0, 3), process.execPath, "-e", fixture], {
          stdio: ["pipe", "pipe", "pipe"],
        }),
    },
  );
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  t.after(async () => {
    host.close();
    await rm(lockDirectory, { recursive: true, force: true });
  });
  const url = `ws://127.0.0.1:${host.server.address().port}/voice`,
    threadId = randomUUID(),
    lifetimeId = await identity(url, { ...config, lockDirectory });
  const first = await connect(url, ticket({ threadId, lifetimeId }));
  first.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
  await once(first, "message");
  const second = await connect(url, ticket({ threadId: threadId.toUpperCase(), lifetimeId }));
  await once(second, "close");
  first.close();
  await once(first, "close");
});
