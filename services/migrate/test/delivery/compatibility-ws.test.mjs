import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compatibilityDatabaseTransport,
  startSourceCompatibilityWorker,
} from "../../src/delivery/compatibility-ws.mjs";

const require = createRequire(import.meta.url),
  { WebSocket } = require("ws");
const auth = (code) => {
  const b = Buffer.alloc(9);
  b[0] = 82;
  b.writeUInt32BE(8, 1);
  b.writeUInt32BE(code, 5);
  return b;
};
const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
const completed = Buffer.concat([Buffer.from([67, 0, 0, 0, 13]), Buffer.from("SELECT 1\0")]);
const startupFrame = (user = "fixture", database = "hive_d10_test") => {
  const parameters = Buffer.from(`user\0${user}\0database\0${database}\0\0`),
    frame = Buffer.alloc(8 + parameters.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(196608, 4);
  parameters.copy(frame, 8);
  return frame;
};
const startup = startupFrame();
const password = Buffer.from([112, 0, 0, 0, 5, 0]);
const query = Buffer.from([81, 0, 0, 0, 5, 0]);
async function fixture(handler, knownTrustFixture = true) {
  const sockets = new Set(),
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      handler(socket);
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = await compatibilityDatabaseTransport(
    `postgresql://fixture@127.0.0.1:${server.address().port}/hive_d10_test`,
    { knownTrustFixture },
  );
  return {
    transport,
    async close() {
      await transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function client(transport) {
  const socket = new WebSocket(transport.origin, {
    headers: { "X-Hive-Compatibility-Version": "0" },
  });
  socket.on("error", () => {});
  await once(socket, "open");
  return socket;
}
const closed = (socket) =>
  Promise.race([
    once(socket, "close"),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("test close timeout")), 2000);
      timer.unref();
    }),
  ]);
test("isolated transport rejects nonfixture targets and ambiguous trust credentials before listening", async () => {
  for (const url of [
    "postgresql://u@db.example:5432/hive_d10_test",
    "postgresql://u@127.0.0.1:5432/production",
    "postgresql://u:p@127.0.0.1:5432/hive_d10_test",
  ])
    await assert.rejects(
      compatibilityDatabaseTransport(url, { knownTrustFixture: true }),
      /fixture_scope/,
    );
});
test("known trust waits for real AuthenticationOk before dropping only initial pipelined Password and forwarding query", async () => {
  let received = Buffer.alloc(0),
    startupRead = false;
  const f = await fixture((socket) =>
    socket.on("data", (data) => {
      received = Buffer.concat([received, data]);
      if (!startupRead && received.length >= startup.length) {
        startupRead = true;
        socket.write(Buffer.concat([auth(0), ready]));
      } else if (received.length >= startup.length + query.length)
        socket.write(Buffer.concat([completed, ready]));
    }),
  );
  let socket;
  try {
    socket = await client(f.transport);
    socket.send(startup.subarray(0, 4));
    socket.send(Buffer.concat([startup.subarray(4), password, query]));
    for (let i = 0; i < 100 && f.transport.counts[0].queries === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(received, Buffer.concat([startup, query]));
    assert.equal(f.transport.counts[0].queries, 1);
  } finally {
    socket?.terminate();
    await f.close();
  }
});
test("unknown authentication closes a declared trust fixture without forwarding or discarding arbitrary auth data", async () => {
  let received = Buffer.alloc(0);
  const f = await fixture((socket) =>
    socket.on("data", (data) => {
      received = Buffer.concat([received, data]);
      socket.write(auth(10));
    }),
  );
  let socket;
  try {
    socket = await client(f.transport);
    const done = closed(socket);
    socket.send(Buffer.concat([startup, password, query]));
    await done;
    assert.deepEqual(received, startup);
    assert.equal(f.transport.counts[0].queries, 0);
  } finally {
    socket?.terminate();
    await f.close();
  }
});
for (const [label, bytes] of [
  ["typed packet before startup", Buffer.concat([password, Buffer.alloc(2)])],
  ["SSL request", Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])],
])
  test(`rejects ${label} rather than treating it as password pipelining`, async () => {
    let bytesSeen = 0;
    const f = await fixture((socket) =>
      socket.on("data", (data) => {
        bytesSeen += data.length;
      }),
    );
    let socket;
    try {
      socket = await client(f.transport);
      const done = closed(socket);
      socket.send(bytes);
      await done;
      assert.equal(bytesSeen, 0);
    } finally {
      socket?.terminate();
      await f.close();
    }
  });
for (const knownTrustFixture of [true, false])
  for (const [label, frame] of [
    ["foreign database", startupFrame("fixture", "postgres")],
    ["foreign user", startupFrame("another", "hive_d10_test")],
  ])
    test(`rejects ${label} before forwarding startup in ${knownTrustFixture ? "trust" : "password"} fixture mode`, async () => {
      let bytesSeen = 0;
      const f = await fixture(
        (socket) =>
          socket.on("data", (data) => {
            bytesSeen += data.length;
          }),
        knownTrustFixture,
      );
      let socket;
      try {
        socket = await client(f.transport);
        const done = closed(socket);
        socket.send(Buffer.concat([frame, password, query]));
        await done;
        assert.equal(bytesSeen, 0);
        assert.equal(f.transport.counts[0].queries, 0);
      } finally {
        socket?.terminate();
        await f.close();
      }
    });
for (const [label, request, reply] of [
  ["standalone Sync", Buffer.from([83, 0, 0, 0, 4]), ready],
  ["empty query", query, Buffer.concat([Buffer.from([73, 0, 0, 0, 4]), ready])],
  ["failed command", query, Buffer.concat([completed, Buffer.from([69, 0, 0, 0, 4]), ready])],
])
  test(`${label} cannot establish successful application SQL`, async () => {
    let startupRead = false,
      responseBytes = 0;
    const f = await fixture((socket) =>
      socket.on("data", () => {
        if (!startupRead) {
          startupRead = true;
          socket.write(Buffer.concat([auth(0), ready]));
        } else socket.write(reply);
      }),
    );
    let socket;
    try {
      socket = await client(f.transport);
      socket.on("message", (bytes) => {
        responseBytes += bytes.length;
      });
      socket.send(Buffer.concat([startup, password, request]));
      const expected = auth(0).length + ready.length + reply.length;
      for (let i = 0; i < 100 && responseBytes < expected; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(responseBytes, expected);
      assert.equal(f.transport.counts[0].queries, 0);
    } finally {
      socket?.terminate();
      await f.close();
    }
  });
test("ordinary password authentication remains transparent and never enables the trust discard path", async () => {
  let received = Buffer.alloc(0);
  const f = await fixture(
    (socket) =>
      socket.on("data", (data) => {
        received = Buffer.concat([received, data]);
        socket.end();
      }),
    false,
  );
  let socket;
  try {
    socket = await client(f.transport);
    const done = closed(socket);
    socket.send(Buffer.concat([startup, password, query]));
    await done;
    assert.deepEqual(received, Buffer.concat([startup, password, query]));
  } finally {
    socket?.terminate();
    await f.close();
  }
});
test("artifact egress cannot target arbitrary HTTP services through the isolated Neon route", async () => {
  const f = await fixture(() => {}),
    directory = await mkdtemp(join(tmpdir(), "compatibility-egress-"));
  let worker;
  try {
    worker = await startSourceCompatibilityWorker({
      files: new Map([
        [
          "app/worker.js",
          Buffer.from("export default{fetch(){return fetch('https://example.invalid/private')}}"),
        ],
      ]),
      directory,
      port: 0,
      bindings: {},
      date: "2026-10-29",
      transport: f.transport,
      version: 0,
    });
    const response = await worker.dispatchFetch("http://fixture.invalid/");
    assert.equal(response.status, 403);
    assert.equal(f.transport.counts[0].connections, 0);
  } finally {
    await worker?.dispose();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
