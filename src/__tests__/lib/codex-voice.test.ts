import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { nativeVoiceSocket, VoiceRequestRejected, VoiceRpc } from "@/lib/codex/voice-rpc";
import { createVoiceStream, listVoiceThreads } from "@/lib/codex/voice-session";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});

async function pair() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const [socket] = (await connected) as [WebSocket];
  await once(client, "open");
  const rpc = new VoiceRpc(nativeVoiceSocket(client as unknown as globalThis.WebSocket));
  cleanup.push(() => {
    rpc.close();
    socket.terminate();
    server.close();
  });
  return { rpc, socket };
}

describe("Codex voice RPC", () => {
  it("correlates concurrent requests and sanitizes upstream errors", async () => {
    const { rpc, socket } = await pair();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      socket.send(
        JSON.stringify(
          message.method === "reject"
            ? { id: message.id, error: { message: "secret credential" } }
            : { id: message.id, result: message.params },
        ),
      );
    });
    const result = await Promise.all([
      rpc.request("one", { value: 1 }),
      rpc.request("two", { value: 2 }),
    ]);
    expect(result).toEqual([{ value: 1 }, { value: 2 }]);
    await expect(rpc.request("reject", {})).rejects.toBeInstanceOf(VoiceRequestRejected);
    await expect(rpc.request("reject", {})).rejects.not.toThrow("secret");
  });

  it("rejects pending work on disconnect and bounds requests without responses", async () => {
    const { rpc, socket } = await pair();
    await expect(rpc.request("unanswered", {}, 10)).rejects.toThrow("timed out");
    const pending = rpc.request("unanswered", {});
    socket.close();
    await expect(pending).rejects.toThrow("closed");
  });
});

function fakeRpc() {
  return {
    request: vi.fn().mockResolvedValue({}),
    close: vi.fn(),
    onNotification: () => {},
    onClose: () => {},
  } as unknown as VoiceRpc & { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe("thread-scoped voice", () => {
  it("lists only loaded, directly interactive threads without resuming or reading turns", async () => {
    const rpc = fakeRpc();
    rpc.request.mockImplementation(async (method, params) =>
      method === "thread/loaded/list"
        ? { data: ["parent", "child", "blocked"] }
        : {
            thread: {
              id: params.threadId,
              cwd: "/project",
              parentThreadId: params.threadId === "child" ? "parent" : null,
              canAcceptDirectInput: params.threadId !== "blocked",
            },
          },
    );
    expect(await listVoiceThreads(rpc)).toEqual([
      { id: "parent", name: "parent", cwd: "/project" },
    ]);
    expect(rpc.request).toHaveBeenCalledWith("thread/read", {
      threadId: "parent",
      includeTurns: false,
    });
    expect(rpc.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
  });

  it("rejects oversized, duplicate, and malformed loaded thread lists before reading threads", async () => {
    for (const data of [
      Array.from({ length: 101 }, (_, i) => `thread-${i}`),
      ["same", "same"],
      ["x".repeat(201)],
      [null],
    ]) {
      const rpc = fakeRpc();
      rpc.request.mockResolvedValue({ data });
      await expect(listVoiceThreads(rpc)).rejects.toThrow("Invalid Codex thread list");
      expect(rpc.request).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects a thread read that returns a different thread", async () => {
    const rpc = fakeRpc();
    rpc.request
      .mockResolvedValueOnce({ data: ["selected"] })
      .mockResolvedValueOnce({ thread: { id: "other", cwd: "/project" } });
    await expect(listVoiceThreads(rpc)).rejects.toThrow("Invalid Codex thread");
  });

  it("filters other threads and stops its session before closing on browser cancellation", async () => {
    const rpc = fakeRpc();
    const abort = new AbortController();
    const reader = createVoiceStream(rpc, "selected", "offer", abort.signal).getReader();
    rpc.onNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "other", sdp: "wrong" },
    });
    rpc.onNotification({
      method: "thread/realtime/sdp",
      params: { threadId: "selected", sdp: "answer" },
    });
    const response = await reader.read();
    expect(new TextDecoder().decode(response.value)).toContain('"sdp":"answer"');
    abort.abort();
    await vi.waitFor(() => expect(rpc.close).toHaveBeenCalled());
    expect(rpc.request).toHaveBeenCalledWith(
      "thread/realtime/stop",
      { threadId: "selected" },
      3000,
    );
  });

  it("does not stop an existing call when Codex rejects startup", async () => {
    const rpc = fakeRpc();
    rpc.request.mockRejectedValue(new VoiceRequestRejected("already active"));
    const reader = createVoiceStream(
      rpc,
      "selected",
      "offer",
      new AbortController().signal,
    ).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"error"');
    expect(rpc.request).toHaveBeenCalledTimes(1);
    expect(rpc.close).toHaveBeenCalled();
  });

  it("does not stop an uncertain startup after a timeout", async () => {
    const rpc = fakeRpc();
    rpc.request.mockRejectedValueOnce(new Error("timeout"));
    createVoiceStream(rpc, "selected", "offer", new AbortController().signal);
    await vi.waitFor(() => expect(rpc.close).toHaveBeenCalled());
    expect(rpc.request).toHaveBeenCalledTimes(1);
    const canceled = fakeRpc();
    createVoiceStream(canceled, "selected", "offer", AbortSignal.abort());
    expect(canceled.request).not.toHaveBeenCalled();
    expect(canceled.close).toHaveBeenCalled();
  });

  it("waits for pending startup before stopping and never stops a rejected call", async () => {
    for (const accepted of [true, false]) {
      const rpc = fakeRpc();
      let resolve!: () => void, reject!: (error: Error) => void;
      const pending = new Promise<void>((a, b) => {
        resolve = a;
        reject = b;
      });
      rpc.request.mockImplementation((method) =>
        method === "thread/realtime/start" ? pending : Promise.resolve({}),
      );
      const abort = new AbortController();
      createVoiceStream(rpc, "selected", "offer", abort.signal);
      abort.abort();
      expect(rpc.request).toHaveBeenCalledTimes(1);
      if (accepted) resolve();
      else reject(new VoiceRequestRejected("already active"));
      await vi.waitFor(() => expect(rpc.close).toHaveBeenCalled());
      expect(rpc.request.mock.calls.some(([method]) => method === "thread/realtime/stop")).toBe(
        accepted,
      );
    }
  });

  it("does not stop after the pending call closes before its accepted response", async () => {
    const rpc = fakeRpc();
    let accept!: () => void;
    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
    rpc.request.mockImplementation((method) =>
      method === "thread/realtime/start" ? pending : Promise.resolve({}),
    );
    const abort = new AbortController();
    createVoiceStream(rpc, "selected", "offer", abort.signal);
    abort.abort();
    rpc.onNotification({ method: "thread/realtime/closed", params: { threadId: "selected" } });
    accept();
    await vi.waitFor(() => expect(rpc.close).toHaveBeenCalled());
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });

  it("rejects an incomplete listing beyond its ten-page bound", async () => {
    const rpc = fakeRpc();
    let page = 0;
    rpc.request.mockImplementation(async () => ({
      data: [`thread-${page}`],
      nextCursor: `cursor-${++page}`,
    }));
    await expect(listVoiceThreads(rpc)).rejects.toThrow("Invalid Codex thread cursor");
    expect(rpc.request).toHaveBeenCalledTimes(10);
  });

  it("paginates loaded threads and rejects cursor loops and duplicates across pages", async () => {
    const rpc = fakeRpc();
    rpc.request.mockImplementation(async (method, params) =>
      method === "thread/loaded/list"
        ? params.cursor
          ? { data: ["second"] }
          : { data: ["first"], nextCursor: "page-two" }
        : { thread: { id: params.threadId, cwd: "/project" } },
    );
    expect((await listVoiceThreads(rpc)).map((v) => v.id)).toEqual(["first", "second"]);
    expect(rpc.request).toHaveBeenCalledWith("thread/loaded/list", {
      limit: 100,
      cursor: "page-two",
    });
    for (const second of [{ data: ["first"] }, { data: ["second"], nextCursor: "page-two" }]) {
      const bad = fakeRpc();
      bad.request
        .mockResolvedValueOnce({ data: ["first"], nextCursor: "page-two" })
        .mockResolvedValueOnce(second);
      await expect(listVoiceThreads(bad)).rejects.toThrow();
      expect(bad.request).toHaveBeenCalledTimes(2);
    }
  });
});
