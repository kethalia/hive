import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { TERMINAL_SUBPROTOCOL } from "../../../src/lib/terminal/protocol";

const auth = vi.hoisted(() => ({ coderUrl: "" }));
vi.mock("../src/auth.js", () => ({
  authenticateUpgrade: vi.fn(async () => ({
    ok: true,
    value: { token: "test-token", coderUrl: auth.coderUrl, sessionId: "test-session" },
  })),
}));
vi.mock("../src/workspace-authorization.js", () => ({
  verifyWorkspaceAgentAccess: vi.fn(async () => ({ ok: true })),
}));

import { createTerminalProxyServer } from "../src/index.js";
import { drainTerminalConnections } from "../src/proxy.js";

const servers: Server[] = [];
const sockets: WebSocket[] = [];
const wssInstances: WebSocketServer[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function setup(protocol = true) {
  const coder = createServer();
  const upstream = new WebSocketServer({ noServer: true });
  wssInstances.push(upstream);
  const upgraded = new Promise<() => void>((resolve) => {
    coder.on("upgrade", (req, socket, head) => {
      // Hold the upstream upgrade so the browser/proxy handshake can complete
      // first. This reproduces the real readiness gap without timing sleeps.
      resolve(() =>
        upstream.handleUpgrade(req, socket, head, (ws) => {
          sockets.push(ws);
          upstream.emit("connection", ws, req);
        }),
      );
    });
  });
  auth.coderUrl = await listen(coder);
  const { server } = createTerminalProxyServer({
    keepAliveManager: { start() {}, stop() {}, getHealth: () => ({}) },
  });
  const proxyUrl = await listen(server);
  const params = new URLSearchParams({
    agentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    reconnectId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    workspaceId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
    sessionName: "continuity",
  });
  const browser = new WebSocket(
    `${proxyUrl.replace("http:", "ws:")}/ws?${params}`,
    protocol ? [TERMINAL_SUBPROTOCOL] : [],
    { headers: { Origin: "http://localhost:3000" } },
  );
  sockets.push(browser);
  const frames: { text: string; binary: boolean }[] = [];
  browser.on("message", (data, binary) => frames.push({ text: data.toString(), binary }));
  await once(browser, "open");
  const connectUpstream = await upgraded;
  return { browser, frames, upstream, connectUpstream };
}
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const wss of wssInstances.splice(0)) wss.close();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("terminal continuity over real WebSockets", () => {
  it("acknowledges upstream readiness and separates output from control frames", async () => {
    const { browser, frames, upstream, connectUpstream } = await setup();
    expect(browser.protocol).toBe("hive-terminal-v1");
    expect(frames).toEqual([]);
    const attached = once(upstream, "connection");
    const ready = once(browser, "message");
    connectUpstream();
    const [pty] = (await attached) as [WebSocket];
    await ready;
    expect(frames).toEqual([{ text: '{"type":"hive:ready"}', binary: false }]);
    const output = once(browser, "message");
    pty.send('{"type":"hive:ready"}');
    await output;
    expect(frames.at(-1)).toEqual({ text: '{"type":"hive:ready"}', binary: true });
    const upstreamInput = vi.fn();
    pty.on("message", upstreamInput);
    const pong = once(browser, "message");
    browser.send('{"type":"hive:ping","id":123}');
    await pong;
    expect(frames.at(-1)).toEqual({ text: '{"type":"hive:pong","id":123}', binary: false });
    expect(upstreamInput).not.toHaveBeenCalled();
    const input = once(pty, "message");
    browser.send('{"data":"hello"}');
    const [data] = await input;
    expect(data.toString()).toBe('{"data":"hello"}');
  });

  it("keeps legacy clients compatible during rolling upgrades", async () => {
    const { browser, frames, upstream, connectUpstream } = await setup(false);
    const attached = once(upstream, "connection");
    connectUpstream();
    const [pty] = (await attached) as [WebSocket];
    const output = once(browser, "message");
    pty.send("shell output");
    await output;
    expect(browser.protocol).toBe("");
    expect(frames).toEqual([{ text: "shell output", binary: false }]);
  });
  it("signals a retryable restart and rejects new upgrades while draining", async () => {
    const { browser, upstream, connectUpstream } = await setup();
    const attached = once(upstream, "connection");
    const ready = once(browser, "message");
    connectUpstream();
    await attached;
    await ready;
    const closed = once(browser, "close");
    const terminate = drainTerminalConnections();
    const [code] = await closed;
    expect(code).toBe(1012);
    const rejected = new WebSocket(browser.url, [TERMINAL_SUBPROTOCOL], {
      headers: { Origin: "http://localhost:3000" },
    });
    sockets.push(rejected);
    rejected.on("error", () => {});
    const status = await new Promise<number>((resolve) =>
      rejected.on("unexpected-response", (request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
        request.destroy();
        rejected.terminate();
      }),
    );
    expect(status).toBe(503);
    terminate();
  });
});
