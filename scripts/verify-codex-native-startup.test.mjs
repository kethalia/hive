import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  NATIVE_STARTUP_TIMEOUT_MS,
  waitForNativeSocket,
} from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

async function fixture(t) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = createServer();
  const connections = new Set();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0,
    stops = 0,
    stopPromise;
  server.on("upgrade", (request, socket, head) => {
    upgrades++;
    if (request.headers.authorization !== "Bearer fixed-fixture-token") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  const child = spawn("/usr/bin/python3", ["-I", "-c", "import time; time.sleep(60)"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  const stop = () =>
    (stopPromise ??= (async () => {
      stops++;
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    })());
  t.after(async () => {
    await stop();
    for (const ws of wss.clients) ws.terminate();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return {
    child,
    stop,
    server,
    port,
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    counts: () => ({ stops, upgrades }),
    connect: (options) =>
      waitForNativeSocket({
        child,
        endpoint: `ws://127.0.0.1:${port}`,
        token: "fixed-fixture-token",
        deadline: performance.now() + 1000,
        stop,
        ...options,
      }),
  };
}

test("one authenticated listener may finish durable startup beyond the old four-second retry window", {
  timeout: 8000,
}, async (t) => {
  const f = await fixture(t);
  assert.equal(NATIVE_STARTUP_TIMEOUT_MS, 20000);
  const started = performance.now();
  const listening = setTimeout(() => void f.listen(), 4500);
  t.after(() => clearTimeout(listening));
  const socket = await f.connect({ deadline: started + 6500 });
  assert.ok(performance.now() - started >= 4500);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(f.counts(), { stops: 0, upgrades: 1 });
  socket.terminate();
});

test("absolute deadline stops the one child and closes pending handshake", {
  timeout: 3000,
}, async (t) => {
  const f = await fixture(t);
  const sockets = new Set();
  let ended;
  const peerEnded = new Promise((resolve) => {
    ended = resolve;
  });
  f.server.removeAllListeners("upgrade");
  f.server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("end", () => {
      ended();
      socket.end();
    });
    socket.resume();
  });
  await f.listen();
  const started = performance.now();
  await assert.rejects(f.connect({ deadline: started + 150 }), /native_start_timeout/);
  assert.ok(performance.now() - started < 1000);
  assert.equal(f.counts().stops, 1);
  assert.notEqual(f.child.signalCode, null);
  let timer;
  try {
    await Promise.race([
      peerEnded,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("peer_not_closed")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

test("revocation interrupts readiness before any native initialization", async (t) => {
  const f = await fixture(t);
  let revoked = false;
  const timer = setTimeout(() => {
    revoked = true;
  }, 80);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    f.connect({
      executionAuthority: {
        fence: async () => {},
        assert: () => {
          if (revoked) throw new Error("execution_revoked");
        },
      },
    }),
    /execution_revoked/,
  );
  assert.deepEqual(f.counts(), { stops: 1, upgrades: 0 });
});

test("deadline bounds a stalled authority fence without accepting its late completion", async (t) => {
  const f = await fixture(t);
  let finish;
  await assert.rejects(
    f.connect({
      deadline: performance.now() + 100,
      executionAuthority: {
        assert: () => {},
        fence: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    }),
    /native_start_timeout/,
  );
  finish();
  assert.deepEqual(f.counts(), { stops: 1, upgrades: 0 });
});

test("authority is checked again after authenticated WebSocket open", async (t) => {
  const f = await fixture(t);
  await f.listen();
  let fences = 0;
  await assert.rejects(
    f.connect({
      executionAuthority: {
        assert: () => {},
        fence: async () => {
          if (++fences === 2) throw new Error("registration_expired");
        },
      },
    }),
    /registration_expired/,
  );
  assert.deepEqual(f.counts(), { stops: 1, upgrades: 1 });
});

test("cancellation and early child exit abort readiness without relaunch", async (t) => {
  for (const reason of ["cancel", "exit"]) {
    const f = await fixture(t),
      controller = new AbortController();
    const timer = setTimeout(
      () => (reason === "cancel" ? controller.abort() : f.child.kill("SIGTERM")),
      30,
    );
    t.after(() => clearTimeout(timer));
    await assert.rejects(
      f.connect({ signal: controller.signal }),
      reason === "cancel" ? /native_start_cancelled/ : /native_start_failed/,
    );
    assert.deepEqual(f.counts(), { stops: 1, upgrades: 0 });
  }
});

test("wrong authentication is a terminal handshake rejection, not a retry", async (t) => {
  const f = await fixture(t);
  await f.listen();
  await assert.rejects(f.connect({ token: "wrong-fixture-token" }), /native_handshake_rejected/);
  assert.deepEqual(f.counts(), { stops: 1, upgrades: 1 });
});
