import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("terminal paste asset upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      files: [
        {
          name: "unsafe path.txt",
          type: "text/plain",
          bytes: expect.any(Uint8Array),
        },
      ],
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
      files: [{ name: "document.pdf", type: "application/pdf", bytes: expect.any(Uint8Array) }],
    });
    const uploadedBytes = mockUploadTerminalPasteAssets.mock.calls[0][0].files[0].bytes;
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

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Pasted file is too large" });
    expect(mockUploadTerminalPasteAssets).not.toHaveBeenCalled();
  });
});
