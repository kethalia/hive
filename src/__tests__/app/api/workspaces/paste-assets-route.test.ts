import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetRequestSession = vi.hoisted(() => vi.fn());
const mockUploadTerminalPasteAssets = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  getRequestSession: mockGetRequestSession,
}));

vi.mock("@/lib/workspace/paste-assets", () => ({
  TERMINAL_PASTE_ASSET_MAX_BYTES: 10 * 1024 * 1024,
  TERMINAL_PASTE_ASSET_MAX_FILES: 10,
  uploadTerminalPasteAssets: mockUploadTerminalPasteAssets,
}));

import { POST } from "@/app/api/workspaces/[workspaceId]/terminal/paste-assets/route";
import { TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES } from "@/lib/terminal/paste-limits";
import { TERMINAL_PASTE_MAX_ACTIVE_REQUESTS } from "@/lib/workspace/paste-admission";
import { TERMINAL_PASTE_REQUEST_TIMEOUT_MS } from "@/lib/workspace/paste-request";

describe("terminal paste asset upload route", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadTerminalPasteAssets.mockReset();
    mockGetRequestSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { sessionId: "sess-1" },
    });
    mockUploadTerminalPasteAssets.mockResolvedValue(["/tmp/hive-terminal-paste/image.png"]);
  });

  it("requires authentication", async () => {
    mockGetRequestSession.mockResolvedValue(null);
    const response = await POST(new Request("https://hive.test/upload", { method: "POST" }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(401);
    expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
  });

  it("uploads multipart files without returning original payloads", async () => {
    const body = new FormData();
    body.append("files", new File(["file-bytes"], "unsafe path.txt", { type: "text/plain" }));

    const response = await POST(new Request("https://hive.test/upload", { method: "POST", body }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paths: ["/tmp/hive-terminal-paste/image.png"] });
    expect(mockUploadTerminalPasteAssets).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [expect.objectContaining({ name: "unsafe path.txt", type: "text/plain" })],
      signal: expect.any(AbortSignal),
    });
  });

  it("accepts non-image file types", async () => {
    const body = new FormData();
    body.append("files", new File(["not-image"], "notes.txt", { type: "text/plain" }));

    const response = await POST(new Request("https://hive.test/upload", { method: "POST", body }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockUploadTerminalPasteAssets).toHaveBeenCalledOnce();
  });

  it("accepts a 2.5 MiB PDF and preserves its type, name, and bytes", async () => {
    const bytes = new Uint8Array(2.5 * 1024 * 1024);
    bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
    const body = new FormData();
    body.append("files", new File([bytes], "document.pdf", { type: "application/pdf" }));
    mockUploadTerminalPasteAssets.mockResolvedValue(["/tmp/hive-terminal-paste/document.pdf"]);

    const response = await POST(new Request("https://hive.test/upload", { method: "POST", body }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paths: ["/tmp/hive-terminal-paste/document.pdf"] });
    expect(mockUploadTerminalPasteAssets).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [expect.objectContaining({ name: "document.pdf", type: "application/pdf" })],
      signal: expect.any(AbortSignal),
    });
    const uploadedBytes =
      await mockUploadTerminalPasteAssets.mock.calls[0][0].files[0].arrayBuffer();
    expect(Buffer.from(uploadedBytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("rejects oversized files before reading bytes", async () => {
    const body = new FormData();
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    body.append("files", file);

    const response = await POST(new Request("https://hive.test/upload", { method: "POST", body }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Pasted file is too large" });
    expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
  });
});

function pasteRequest(signal?: AbortSignal) {
  const body = new FormData();
  body.append("files", new File(["hello"], "hello.txt"));
  return new Request("https://hive.test/upload", { method: "POST", body, signal });
}

function streamRequest(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request("https://hive.test/upload", {
    method: "POST",
    body,
    headers: { "Content-Type": "multipart/form-data; boundary=test", ...headers },
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

const context = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

describe("paste resource boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequestSession.mockResolvedValue({ user: { id: "user-1" } });
    mockUploadTerminalPasteAssets.mockReset().mockResolvedValue(["/tmp/result.txt"]);
  });
  afterEach(() => vi.useRealTimers());

  it("rejects an advertised oversized body without reading or parsing it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const request = streamRequest(body, {
      "Content-Length": String(TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES + 1),
    });
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      const response = await POST(request, context);
      expect(response.status).toBe(413);
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(parse).not.toHaveBeenCalled();
      expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it.each([undefined, "1"])("counts streamed bytes with Content-Length=%s", async (length) => {
    const cancel = vi.fn();
    let reads = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(chunk);
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      const response = await POST(
        streamRequest(body, length ? { "Content-Length": length } : {}),
        context,
      );
      expect(response.status).toBe(413);
      expect(reads).toBe(TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES / chunk.byteLength + 1);
      expect(cancel).toHaveBeenCalledOnce();
      expect(parse).not.toHaveBeenCalled();
      expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it.each(["-1", "NaN", "1, 2"])("rejects malformed Content-Length %s", async (length) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const response = await POST(streamRequest(body, { "Content-Length": length }), context);
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects aggregate files over 20 MiB before starting uploads", async () => {
    const body = new FormData();
    for (const size of [10 * 1024 * 1024, 10 * 1024 * 1024, 1]) {
      body.append("files", new File([new Uint8Array(size)], "file.bin"));
    }
    const response = await POST(
      new Request("https://hive.test/upload", { method: "POST", body }),
      context,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Paste files must total 20 MiB or less" });
    expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
  });

  it("accepts exactly 20 MiB of files plus normal multipart overhead", async () => {
    const body = new FormData();
    for (let i = 0; i < 2; i++)
      body.append("files", new File([new Uint8Array(10 * 1024 * 1024)], "file.bin"));
    const response = await POST(
      new Request("https://hive.test/upload", { method: "POST", body }),
      context,
    );
    expect(response.status).toBe(200);
    expect(mockUploadTerminalPasteAssets).toHaveBeenCalledOnce();
  });

  it("rejects concurrent pastes for one user before reading the second body, then releases the slot", async () => {
    let finish!: (paths: string[]) => void;
    mockUploadTerminalPasteAssets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = POST(pasteRequest(), context);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const pull = vi.fn();
    const cancel = vi.fn();
    try {
      const second = await POST(
        streamRequest(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })),
        context,
      );
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("2");
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      finish(["/tmp/result.txt"]);
      await first;
    }
    expect((await POST(pasteRequest(), context)).status).toBe(200);
  });

  it("keeps admission during transfer cancellation until the helper confirms process exit", async () => {
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    let transferSignal: AbortSignal | undefined;
    mockUploadTerminalPasteAssets.mockImplementationOnce(({ signal }) => {
      transferSignal = signal;
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });
    const first = POST(pasteRequest(controller.signal), context);
    await vi.waitFor(() => expect(transferSignal).toBeDefined());
    controller.abort();
    expect(transferSignal!.aborted).toBe(true);
    try {
      expect(
        (await POST(streamRequest(new ReadableStream({}, { highWaterMark: 0 })), context)).status,
      ).toBe(429);
    } finally {
      fail(new Error("SSH closed"));
    }
    expect((await first).status).toBe(408);
    expect((await POST(pasteRequest(), context)).status).toBe(200);
  });

  it("bounds simultaneous users and releases global capacity", async () => {
    const finishes: ((paths: string[]) => void)[] = [];
    const pending: Promise<Response>[] = [];
    mockUploadTerminalPasteAssets.mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    try {
      for (let i = 0; i < TERMINAL_PASTE_MAX_ACTIVE_REQUESTS; i++) {
        mockGetRequestSession.mockResolvedValue({ user: { id: `user-${i}` } });
        pending.push(POST(pasteRequest(), context));
        await vi.waitFor(() => expect(finishes).toHaveLength(i + 1));
      }
      mockGetRequestSession.mockResolvedValue({ user: { id: "other-user" } });
      expect(
        (await POST(streamRequest(new ReadableStream({}, { highWaterMark: 0 })), context)).status,
      ).toBe(429);
    } finally {
      finishes.forEach((finish) => {
        finish([]);
      });
      await Promise.all(pending);
    }
    mockUploadTerminalPasteAssets.mockResolvedValue([]);
    expect((await POST(pasteRequest(), context)).status).toBe(200);
  });

  it("releases admission after multipart errors and upload failures", async () => {
    const bad = streamRequest(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("bad"));
          controller.close();
        },
      }),
    );
    expect((await POST(bad, context)).status).toBe(400);
    mockUploadTerminalPasteAssets.mockRejectedValueOnce(new Error("SSH failed"));
    expect((await POST(pasteRequest(), context)).status).toBe(400);
    expect((await POST(pasteRequest(), context)).status).toBe(200);
  });

  it.each([
    "abort",
    "timeout",
  ])("cancels stalled reads on %s even if source cancellation never resolves", async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const response = POST(streamRequest(body, {}, controller.signal), context);
    await vi.advanceTimersByTimeAsync(0);
    if (kind === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(TERMINAL_PASTE_REQUEST_TIMEOUT_MS);
    expect((await response).status).toBe(kind === "abort" ? 408 : 504);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
    expect((await POST(pasteRequest(), context)).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("multipart allocation bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequestSession.mockResolvedValue({ user: { id: "user-1" } });
    mockUploadTerminalPasteAssets.mockReset().mockResolvedValue([]);
  });

  function multipartRequest(body: string, contentType = "multipart/form-data; boundary=test") {
    return new Request("https://hive.test/upload", {
      method: "POST",
      body,
      headers: { "Content-Type": contentType },
    });
  }

  const filePart =
    '--test\r\nContent-Disposition: form-data; name="files"; filename="empty.txt"\r\nContent-Type: text/plain\r\n\r\n\r\n';
  const fieldPart = '--test\r\nContent-Disposition: form-data; name="unused"\r\n\r\n\r\n';

  it.each([
    filePart,
    fieldPart,
  ])("rejects 100,000 empty parts under the byte cap without invoking the parser", async (part) => {
    const body = `${part.repeat(100_000)}--test--\r\n`;
    expect(Buffer.byteLength(body)).toBeLessThan(TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES);
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      const response = await POST(multipartRequest(body), context);
      expect(response.status).toBe(413);
      expect(parse).not.toHaveBeenCalled();
      expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    "multipart/form-data; boundary=test",
    'multipart/form-data; boundary="test"; charset=UTF-8',
    'multipart/form-data; boundary="te\\st"',
    "multipart/form-data; boundary=test; boundary=alternate",
  ])("accepts ten parts using a single canonical boundary: %s", async (contentType) => {
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      expect(
        (await POST(multipartRequest(`${filePart.repeat(10)}--test--\r\n`, contentType), context))
          .status,
      ).toBe(200);
      expect(parse).toHaveBeenCalledOnce();
      expect((parse.mock.contexts[0] as Response).headers.get("content-type")).toBe(
        'multipart/form-data; boundary="test"',
      );
    } finally {
      parse.mockRestore();
    }
  });

  it("counts unused fields together with files before parsing", async () => {
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      expect(
        (await POST(multipartRequest(`${filePart.repeat(10)}${fieldPart}--test--\r\n`), context))
          .status,
      ).toBe(413);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it.each([
    "multipart/form-data",
    "multipart/form-data; boundary=",
    'multipart/form-data; boundary="bad "',
    `multipart/form-data; boundary=${"b".repeat(71)}`,
    'multipart/form-data; boundary="bad\\"quote"',
  ])("rejects invalid boundaries before parsing: %s", async (contentType) => {
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      expect(
        (await POST(multipartRequest(`${filePart}--test--\r\n`, contentType), context)).status,
      ).toBe(400);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
