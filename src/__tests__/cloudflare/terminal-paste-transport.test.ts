import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { transferTerminalPaste } from "../../../deploy/cloudflare/app/terminal-paste-transport";

function fixture(mode = "normal") {
  const listeners = new Map<string, Set<(value: any) => void>>();
  let nonce = "",
    manifest: any[] = [],
    index = 0,
    bytes = 0;
  const received: Buffer[] = [];
  const emit = (value: unknown) =>
    queueMicrotask(() =>
      listeners.get("message")?.forEach((fn) => {
        fn({
          data: new TextEncoder().encode(`${JSON.stringify({ nonce, ...(value as object) })}\n`)
            .buffer,
        });
      }),
    );
  const completed = () => {
    emit({
      type: "file",
      index,
      size: bytes,
      sha256: manifest[index].sha256,
      path: `/tmp/hive-terminal-paste/${mode === "wrong-path" ? "other" : manifest[index].name}`,
    });
    if (index === manifest.length - 1) emit({ type: "complete" });
  };
  const socket = {
    readyState: 1,
    accept: vi.fn(() => emit({ type: "ready" })),
    close: vi.fn(),
    addEventListener: (event: string, fn: (value: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(fn);
    },
    removeEventListener: (event: string, fn: any) => listeners.get(event)?.delete(fn),
    send: vi.fn((raw: ArrayBufferView) => {
      const packet = JSON.parse(new TextDecoder().decode(raw));
      const frame = JSON.parse(packet.data);
      if (frame.files) {
        manifest = frame.files;
        emit({ type: "manifest" });
      } else if (frame.type === "file") {
        index = frame.index;
        bytes = 0;
        if (!manifest[index].size) completed();
      } else {
        const data = Buffer.from(frame.data, "base64");
        received.push(data);
        bytes += data.length;
        emit({
          type: "chunk",
          index,
          sequence: mode === "wrong-sequence" ? frame.sequence + 1 : frame.sequence,
        });
        if (bytes === manifest[index].size) completed();
      }
    }),
  };
  const fetching = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    nonce = url.searchParams.get("command")?.split(" ").at(-1) ?? "";
    expect(url.origin).toBe("https://coder.example");
    expect(url.pathname).toBe("/api/v2/workspaceagents/10000000-0000-4000-8000-000000000001/pty");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Coder-Session-Token")).toBe("private-token");
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    return { status: 101, redirected: false, webSocket: socket } as unknown as Response;
  });
  const data = Buffer.from([
    0,
    255,
    13,
    10,
    27,
    ...Array.from({ length: 20000 }, (_, i) => i % 256),
  ]);
  const authorize = vi.fn(async () => {});
  const run = (
    files = [
      {
        name: "generated.bin",
        bytes: data,
        sha256: createHash("sha256").update(data).digest("hex"),
      },
    ],
    signal = new AbortController().signal,
  ) =>
    transferTerminalPaste({
      origin: "https://coder.example",
      agentId: "10000000-0000-4000-8000-000000000001",
      token: "private-token",
      files,
      signal,
      authorize,
      fetch: fetching,
    });
  return { run, socket, fetching, received, data, authorize };
}
describe("fixed terminal paste PTY transport", () => {
  it("sends exact binary bytes in ACK-paced bounded chunks with generated command", async () => {
    const f = fixture();
    expect(await f.run()).toEqual(["/tmp/hive-terminal-paste/generated.bin"]);
    expect(Buffer.concat(f.received)).toEqual(f.data);
    expect(f.fetching).toHaveBeenCalledOnce();
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.authorize).toHaveBeenCalled();
    expect(f.socket.send.mock.calls.every(([value]) => value.byteLength < 32768)).toBe(true);
  });
  it.each([
    "wrong-path",
    "wrong-sequence",
  ])("holds mismatched %s ACK without any reconnect/retry", async (mode) => {
    const f = fixture(mode);
    await expect(f.run()).rejects.toThrow("paste_ack");
    expect(f.fetching).toHaveBeenCalledOnce();
    expect(f.socket.close).toHaveBeenCalledOnce();
  });
  it("serializes all ten empty files rather than allowing unsolicited response growth", async () => {
    const f = fixture();
    const files = Array.from({ length: 10 }, (_, index) => ({
      name: `generated-${index}`,
      bytes: new Uint8Array(),
      sha256: createHash("sha256").digest("hex"),
    }));
    expect(await f.run(files)).toHaveLength(10);
  });
  it("aborted late upgrade is closed and never reused for an upload", async () => {
    const f = fixture();
    const controller = new AbortController();
    let resolve!: (value: Response) => void;
    f.fetching.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const task = f.run(undefined, controller.signal);
    controller.abort();
    await expect(task).rejects.toThrow();
    resolve({ status: 101, webSocket: f.socket } as unknown as Response);
    await new Promise((done) => setTimeout(done, 0));
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.socket.send).not.toHaveBeenCalled();
  });
  it("fresh authority failure after READY sends no file bytes", async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(new Error("revoked"));
    await expect(f.run()).rejects.toThrow("revoked");
    expect(f.socket.send).not.toHaveBeenCalled();
    expect(f.socket.close).toHaveBeenCalledOnce();
  });
  it("closes any socket supplied on an invalid provider upgrade response", async () => {
    const f = fixture();
    f.fetching.mockResolvedValue({
      status: 302,
      redirected: true,
      webSocket: f.socket,
    } as unknown as Response);
    await expect(f.run()).rejects.toThrow("paste_transport");
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.socket.send).not.toHaveBeenCalled();
  });
});
