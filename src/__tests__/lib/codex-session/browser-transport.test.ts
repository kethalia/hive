import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openCodexSessionTransport,
  type SessionGrant,
  type SessionSocket,
} from "@/lib/codex-session/browser-transport";

class FakeSocket extends EventTarget implements SessionSocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: any[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  dropped(code: number) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}
const binding = {
  ownerId: "owner",
  workspaceId: "workspace",
  buildId: "build",
  serverInstanceId: "server",
  threadId: "thread",
};
function grant(changes: Partial<SessionGrant> = {}): SessionGrant {
  return {
    url: "https://app.example.com/session",
    binding,
    protocolVersion: "0.165.0",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    ticket: "header.payload.signature",
    ...changes,
  };
}
const sockets: FakeSocket[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.dropped(1000);
  vi.useRealTimers();
});
function setup(
  initial = grant(),
  freshGrant = vi.fn(async () => grant({ ticket: "new.payload.signature" })),
) {
  const socket = new FakeSocket();
  sockets.push(socket);
  const createSocket = vi.fn(() => socket);
  const promise = openCodexSessionTransport(initial, { freshGrant, createSocket });
  socket.open();
  return { socket, createSocket, promise, freshGrant };
}
async function connect(freshGrant?: ReturnType<typeof vi.fn>) {
  const setupResult = setup(grant(), freshGrant);
  setupResult.socket.message({ type: "authenticated", protocolVersion: "0.165.0", binding });
  return { ...setupResult, transport: await setupResult.promise };
}

describe("browser Codex session transport", () => {
  it("converts only the server's HTTPS endpoint and sends the capability in the first frame", async () => {
    const { socket, createSocket, transport } = await connect();
    expect(createSocket).toHaveBeenCalledWith("wss://app.example.com/session");
    expect(socket.sent).toEqual([{ type: "authenticate", ticket: "header.payload.signature" }]);
    const request = transport.request("initialize", { clientInfo: { name: "hive", version: "1" } });
    socket.message({ id: 1, result: { userAgent: "native/0.165.0" } });
    await expect(request).resolves.toEqual({ userAgent: "native/0.165.0" });
  });

  it.each([
    "http://app.example.com/session",
    "https://app.example.com/session?ticket=secret",
    "https://user:password@app.example.com/session",
    "https://app.example.com/other",
    "https://app.example.com/session#fragment",
  ])("rejects an unsafe grant URL before creating a socket: %s", (url) => {
    const createSocket = vi.fn();
    expect(() =>
      openCodexSessionTransport(grant({ url }), { freshGrant: vi.fn(), createSocket }),
    ).toThrow();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it.each([
    { type: "authenticated", protocolVersion: "0.164.0", binding },
    {
      type: "authenticated",
      protocolVersion: "0.165.0",
      binding: { ...binding, ownerId: "other" },
    },
  ])("rejects a changed handshake identity or runtime version", async (message) => {
    const { socket, promise } = setup();
    const rejected = expect(promise).rejects.toThrow("protocol rejected");
    socket.message(message);
    await rejected;
    expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it("renews automatically on the same connection and accepts only the expected expiry", async () => {
    const { socket, transport, freshGrant, createSocket } = await connect();
    const onClose = vi.fn();
    transport.onClose(onClose);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(freshGrant).toHaveBeenCalledTimes(1);
    expect(socket.sent.at(-1)).toEqual({ type: "renew", ticket: "new.payload.signature" });
    socket.message({ type: "renewed", expiresAt: Math.floor(Date.now() / 1000) + 60 });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it("fails renewal closed on new URL or binding without sending it to another host", async () => {
    for (const change of [
      { url: "https://other.example.com/session" },
      { binding: { ...binding, threadId: "other" } },
    ]) {
      const fresh = vi.fn(async () => grant({ ...change, ticket: "new.payload.signature" }));
      const { transport, socket } = await connect(fresh);
      const closed = vi.fn();
      transport.onClose(closed);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(closed).toHaveBeenCalledWith("revoked");
      expect(socket.sent.some((message) => message.type === "renew")).toBe(false);
    }
  });

  it("closes revoked if fresh authorization fails, hangs, or is rejected, without retries", async () => {
    for (const kind of ["failure", "hang", "rejected"]) {
      const fresh = vi.fn(async () => {
        if (kind === "failure") throw new Error("401");
        if (kind === "hang") return new Promise<SessionGrant>(() => {});
        return grant({ ticket: "new.payload.signature" });
      });
      const { socket, transport } = await connect(fresh);
      const closed = vi.fn();
      transport.onClose(closed);
      await vi.advanceTimersByTimeAsync(40_000);
      if (kind === "rejected") socket.message({ type: "renewalRejected" });
      await vi.advanceTimersByTimeAsync(6000);
      expect(closed).toHaveBeenCalledWith("revoked");
      expect(fresh).toHaveBeenCalledTimes(1);
    }
  });

  it("distinguishes revocation from network loss", async () => {
    for (const [code, reason] of [
      [1008, "revoked"],
      [1006, "disconnected"],
    ] as const) {
      const { socket, transport } = await connect();
      const closed = vi.fn();
      transport.onClose(closed);
      socket.dropped(code);
      expect(closed).toHaveBeenCalledWith(reason);
    }
  });

  it("bounds RPC timeouts and rejects all pending requests after connection loss", async () => {
    const { transport } = await connect();
    const closed = vi.fn();
    transport.onClose(closed);
    const pending = expect(
      transport.request("thread/resume", { threadId: "thread", excludeTurns: true }),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(closed).toHaveBeenCalledWith("disconnected");
  });

  it("rejects malformed RPC errors without orphaning the pending request", async () => {
    const { transport, socket } = await connect();
    const pending = expect(transport.request("initialize", {})).rejects.toThrow(
      "protocol rejected",
    );
    socket.message({ id: 1, error: { code: "bad", message: 123 } });
    await pending;
  });

  it("buffers initial events and rejects another thread or oversized messages", async () => {
    const { transport, socket } = await connect();
    const notification = { method: "thread/reverted", params: { threadId: "thread" } };
    socket.message(notification);
    const listener = vi.fn();
    transport.onNotification(listener);
    expect(listener).toHaveBeenCalledWith(notification);
    const closed = vi.fn();
    transport.onClose(closed);
    socket.message({ method: "thread/reverted", params: { threadId: "other" } });
    expect(closed).toHaveBeenCalledWith("revoked");
    const large = await connect();
    large.socket.dispatchEvent(new MessageEvent("message", { data: "a".repeat(1024 * 1024 + 1) }));
    expect(large.socket.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it("bounds the initial handshake and never sends unauthorized mutation methods", async () => {
    const { promise } = setup();
    const rejected = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    const { transport, socket } = await connect();
    await expect(transport.request("turn/start" as never, {})).rejects.toThrow("not allowed");
    expect(socket.sent).toHaveLength(1);
  });
});
