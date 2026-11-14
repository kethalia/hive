import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openVoicePty, voicePtyCommand } from "@/lib/codex/voice-pty.server";
import { VOICE_PTY_SCRIPT } from "@/lib/codex/voice-pty-script";
import { VoiceRequestRejected } from "@/lib/codex/voice-rpc";
import { createVoiceStream, listVoiceThreads } from "@/lib/codex/voice-session";
import type { RelaySocket } from "@/lib/terminal/relay-types";

const threadId = "11111111-1111-4111-8111-111111111111";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
});
class PythonPty implements RelaySocket {
  readyState = 1;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  private events = new Map<string, Set<(value: never) => void>>();
  private child?: ChildProcessWithoutNullStreams;
  private resolve!: () => void;
  readonly exited = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });
  constructor(
    private script: string,
    private nonce: string,
    private home: string,
    private thread: string,
    private ttl: string,
    private env: Record<string, string>,
  ) {}
  accept() {
    if (this.child) throw Error("fixture socket already accepted");
    this.child = spawn(
      "python3",
      [
        "-I",
        "src/__tests__/lib/fixtures/voice-pty-driver.py",
        Buffer.from(this.script).toString("base64"),
        this.nonce,
        this.thread,
        this.ttl,
      ],
      {
        env: {
          ...process.env,
          HOME: this.home,
          CODEX_HOME: join(this.home, ".codex"),
          ...this.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let text = "";
    this.child.stdout.on("data", (part) => {
      text += String(part);
      while (text.includes("\n")) {
        const index = text.indexOf("\n");
        const bytes = Buffer.from(text.slice(0, index), "base64");
        text = text.slice(index + 1);
        this.emit("message", { data: bytes });
      }
    });
    this.child.stderr.resume();
    this.child.on("error", () => this.emit("error", undefined));
    this.child.on("exit", () => {
      this.readyState = 3;
      this.emit("close", {});
      this.resolve();
    });
  }
  send(value: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 1) throw Error("fixture socket closed");
    const bytes =
      typeof value === "string"
        ? Buffer.from(value)
        : value instanceof ArrayBuffer
          ? Buffer.from(value)
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const data = JSON.parse(bytes.toString()).data;
    this.child!.stdin.write(`${Buffer.from(data).toString("base64")}\n`);
  }
  close() {
    this.readyState = 3;
  }
  addEventListener(event: "message" | "close" | "error", callback: never) {
    let listeners = this.events.get(event);
    if (!listeners) {
      listeners = new Set();
      this.events.set(event, listeners);
    }
    listeners.add(callback);
  }
  removeEventListener(event: string, callback: unknown) {
    this.events.get(event)?.delete(callback as never);
  }
  private emit(event: string, value: unknown) {
    for (const listener of this.events.get(event) ?? []) listener(value as never);
  }
}
async function fixture(
  options: { reject?: boolean; badHandshake?: boolean; changed?: boolean; expiresMs?: number } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "hive-voice-pty-"));
  const record = join(home, "proxy.jsonl");
  const proxy = await readFile("src/__tests__/lib/fixtures/voice-proxy.py", "utf8");
  const script = VOICE_PTY_SCRIPT.replace(
    '["bash","-lc","exec codex app-server proxy"]',
    `[sys.executable,"-u","-c",base64.b64decode("${Buffer.from(proxy).toString("base64")}").decode()]`,
  );
  expect(script).not.toBe(VOICE_PTY_SCRIPT);
  const authority = {
    sessionId: randomUUID(),
    userId: randomUUID(),
    coderUserId: randomUUID(),
    coderOrigin: "https://coder.voice.invalid",
    buildId: randomUUID(),
    agentId: randomUUID(),
    token: "synthetic-scoped-coder-token",
    expiresAt: Date.now() + (options.expiresMs ?? 60000),
  };
  const sockets: PythonPty[] = [];
  const tracked: Promise<void>[] = [];
  const authorize = vi.fn(async () => ({ ...authority }));
  if (options.changed)
    authorize
      .mockResolvedValueOnce(authority)
      .mockResolvedValue({ ...authority, buildId: randomUUID() });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(authority.coderOrigin);
    expect(url.pathname).toBe(`/api/v2/workspaceagents/${authority.agentId}/pty`);
    expect(new Headers(init?.headers).get("Coder-Session-Token")).toBe(authority.token);
    expect(init?.redirect).toBe("manual");
    const command = url.searchParams.get("command")!;
    expect(command.length).toBeLessThan(8192);
    expect(command).not.toContain(authority.token);
    const parts = command.split(" ");
    const socket = new PythonPty(script, parts.at(-3)!, home, parts.at(-2)!, parts.at(-1)!, {
      VOICE_FAKE_RECORD: record,
      VOICE_FAKE_THREAD: threadId,
      VOICE_FAKE_REJECT: options.reject ? "1" : "0",
      VOICE_FAKE_BAD_HANDSHAKE: options.badHandshake ? "1" : "0",
    });
    sockets.push(socket);
    const response = new Response(null);
    Object.defineProperties(response, { status: { value: 101 }, webSocket: { value: socket } });
    return response;
  });
  const connect = (signal = new AbortController().signal, thread?: string) =>
    openVoicePty({ authorize, fetch, track: (promise) => tracked.push(promise) }, signal, thread);
  const records = async () => {
    try {
      return (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  cleanups.push(async () => {
    await Promise.all(tracked);
    await Promise.all(sockets.map((socket) => socket.exited));
    for (const item of await records())
      if (item.pid) {
        expect(() => process.kill(item.pid, 0)).toThrow();
      }
    await rm(home, { recursive: true, force: true });
  });
  return { connect, authorize, fetch, records, tracked, sockets, authority };
}
describe("Codex voice over actual Python PTY and synthetic WebSocket proxy", () => {
  it("embeds only the fixed reviewed program in a bounded command", () => {
    const nonce = randomUUID();
    const command = voicePtyCommand(nonce, 30, threadId);
    const encoded = command.match(/b64decode\("([^"]+)"\)/)![1];
    expect(inflateSync(Buffer.from(encoded, "base64")).toString()).toBe(VOICE_PTY_SCRIPT);
    expect(command.length).toBeLessThan(8192);
    expect(() => voicePtyCommand("injected", 30, threadId)).toThrow();
    expect(() => voicePtyCommand(nonce, 1801, threadId)).toThrow();
  });
  it("preserves initialize, fragmented WebSocket responses and large thread metadata", async () => {
    const f = await fixture();
    const rpc = await f.connect();
    try {
      expect(await listVoiceThreads(rpc)).toEqual([
        { id: threadId, name: `active-${"x".repeat(9000)}`, cwd: "/fixture" },
      ]);
      expect(f.authorize).toHaveBeenCalledTimes(2);
    } finally {
      rpc.close();
    }
    await Promise.all(f.tracked);
    const methods = (await f.records()).map((record) => record.method).filter(Boolean);
    expect(methods).toEqual(["initialize", "initialized", "thread/loaded/list", "thread/read"]);
  });
  it("streams the same selected thread's SDP and stops once before abort cleanup", async () => {
    const f = await fixture();
    const rpc = await f.connect(undefined, threadId);
    const controller = new AbortController();
    const reader = createVoiceStream(
      rpc,
      threadId,
      `v=0\r\nm=audio\r\n${"a=synthetic\r\n".repeat(600)}`,
      controller.signal,
    ).getReader();
    const event = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    expect(event).toEqual({ type: "sdp", sdp: "v=0\r\nm=audio" });
    controller.abort();
    await Promise.all(f.tracked);
    expect(
      (await f.records()).filter((record) => record.method === "thread/realtime/start"),
    ).toHaveLength(1);
    expect(
      (await f.records()).filter((record) => record.method === "thread/realtime/stop"),
    ).toHaveLength(1);
    expect(f.authorize).toHaveBeenCalledTimes(3);
  });
  it("does not stop an existing call after explicit startup rejection", async () => {
    const f = await fixture({ reject: true });
    const rpc = await f.connect(undefined, threadId);
    await expect(
      rpc.request("thread/realtime/start", {
        threadId,
        version: "v3",
        outputModality: "audio",
        transport: { type: "webrtc", sdp: "v=0\r\nm=audio" },
      }),
    ).rejects.toBeInstanceOf(VoiceRequestRejected);
    rpc.close();
    await Promise.all(f.tracked);
    expect((await f.records()).some((record) => record.method === "thread/realtime/stop")).toBe(
      false,
    );
  });
  it("blocks arbitrary RPC before it reaches the existing proxy", async () => {
    const f = await fixture();
    const rpc = await f.connect(undefined, threadId);
    await expect(rpc.request("turn/start", { prompt: "never-forward" })).rejects.toThrow("closed");
    rpc.close();
    await Promise.all(f.tracked);
    expect((await f.records()).some((record) => record.method === "turn/start")).toBe(false);
  });
  it("holds changed build authorization before initializing any RPC", async () => {
    const f = await fixture({ changed: true });
    await expect(f.connect()).rejects.toThrow("authorization changed");
    await Promise.all(f.tracked);
    expect((await f.records()).some((record) => record.method)).toBe(false);
  });
  it("rechecks the current build before forwarding realtime start", async () => {
    const f = await fixture();
    const rpc = await f.connect(undefined, threadId);
    f.authorize.mockResolvedValue({ ...f.authority, buildId: randomUUID() });
    await expect(
      rpc.request("thread/realtime/start", {
        threadId,
        version: "v3",
        outputModality: "audio",
        transport: { type: "webrtc", sdp: "v=0\r\nm=audio" },
      }),
    ).rejects.toThrow("closed");
    rpc.close();
    await Promise.all(f.tracked);
    expect((await f.records()).some((record) => record.method === "thread/realtime/start")).toBe(
      false,
    );
  });
  it("ends an accepted call on the original authorization expiry and reaps the proxy", async () => {
    const f = await fixture({ expiresMs: 2200 });
    const rpc = await f.connect(undefined, threadId);
    await rpc.request("thread/realtime/start", {
      threadId,
      version: "v3",
      outputModality: "audio",
      transport: { type: "webrtc", sdp: "v=0\r\nm=audio" },
    });
    await Promise.all(f.tracked);
    expect(
      (await f.records()).filter((record) => record.method === "thread/realtime/start"),
    ).toHaveLength(1);
    expect(
      (await f.records()).filter((record) => record.method === "thread/realtime/stop"),
    ).toHaveLength(1);
  });
  it("rejects a later fresh credential when the original setup cap has already expired", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    f.authorize
      .mockImplementationOnce(async () => ({ ...f.authority }))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(f.authority.expiresAt + 1);
        return { ...f.authority, expiresAt: Date.now() + 60000 };
      });
    await expect(f.connect()).rejects.toThrow("authorization expired");
    await Promise.all(f.tracked);
    expect((await f.records()).some((record) => record.method)).toBe(false);
  });
  it("rejects an invalid inner WebSocket handshake and cleans up its exact proxy", async () => {
    const f = await fixture({ badHandshake: true });
    await expect(f.connect()).rejects.toThrow("closed");
  });
  it("arms the original expiry while an upgrade is still pending", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    f.authority.expiresAt = Date.now() + 5000;
    f.authorize
      .mockResolvedValueOnce({ ...f.authority })
      .mockResolvedValue({ ...f.authority, expiresAt: Date.now() + 60000 });
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((accept) => {
          resolve = accept;
        }),
    );
    const pending = f.connect();
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    let accepted = false;
    const socket: RelaySocket = {
      readyState: 0,
      accept: vi.fn(() => {
        accepted = true;
      }),
      close: vi.fn(() => {
        if (!accepted) throw Error("accept required");
      }),
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const response = new Response(null);
    Object.defineProperties(response, { status: { value: 101 }, webSocket: { value: socket } });
    resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
    expect(f.authorize).toHaveBeenCalledOnce();
  });
  it("accepts then closes a late upgrade after caller cancellation", async () => {
    const f = await fixture();
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((accept) => {
          resolve = accept;
        }),
    );
    const controller = new AbortController();
    const pending = f.connect(controller.signal);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow();
    let accepted = false;
    const close = vi.fn(() => {
      if (!accepted) throw Error("accept required");
    });
    const socket: RelaySocket = {
      readyState: 0,
      accept: vi.fn(() => {
        accepted = true;
      }),
      close,
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const response = new Response(null);
    Object.defineProperties(response, { status: { value: 101 }, webSocket: { value: socket } });
    resolve(response);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(socket.accept).toHaveBeenCalledOnce();
    expect(accepted).toBe(true);
  });
  it("accepts then closes an unexpected status carrying an upgrade socket", async () => {
    const f = await fixture();
    let accepted = false;
    const close = vi.fn(() => {
      if (!accepted) throw Error("accept required");
    });
    const socket: RelaySocket = {
      readyState: 0,
      accept: vi.fn(() => {
        accepted = true;
      }),
      close,
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const response = new Response(null, { status: 302 });
    Object.defineProperty(response, "webSocket", { value: socket });
    f.fetch.mockResolvedValueOnce(response);
    await expect(f.connect()).rejects.toThrow("unavailable");
    expect(socket.accept).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(accepted).toBe(true);
  });
  it("cleans up when accepting the fetched socket itself fails", async () => {
    const f = await fixture();
    let accepted = false,
      attempts = 0;
    const close = vi.fn(() => {
      if (!accepted) throw Error("accept required");
    });
    const socket: RelaySocket = {
      readyState: 0,
      accept: vi.fn(() => {
        if (++attempts === 1) throw Error("synthetic accept failure");
        accepted = true;
      }),
      close,
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const response = new Response(null);
    Object.defineProperties(response, { status: { value: 101 }, webSocket: { value: socket } });
    f.fetch.mockResolvedValueOnce(response);
    await expect(f.connect()).rejects.toThrow("unavailable");
    await Promise.all(f.tracked);
    expect(close).toHaveBeenCalledOnce();
    expect(accepted).toBe(true);
  });
  it("pre-abort and malformed thread perform no authorization or PTY request", async () => {
    const f = await fixture();
    await expect(f.connect(AbortSignal.abort())).rejects.toThrow();
    await expect(f.connect(undefined, "not-a-thread")).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
