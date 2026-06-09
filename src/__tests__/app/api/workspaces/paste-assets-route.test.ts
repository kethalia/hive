import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetRequestSession = vi.hoisted(() => vi.fn());
const mockUploadTerminalPasteAssets = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  getRequestSession: mockGetRequestSession,
}));

vi.mock("@/lib/workspace/paste-assets", () => ({
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

  it("uploads multipart image files without returning original payloads", async () => {
    const body = new FormData();
    body.append("files", new File(["image-bytes"], "unsafe path.png", { type: "image/png" }));

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
          name: "unsafe path.png",
          type: "image/png",
          bytes: expect.any(Uint8Array),
        },
      ],
    });
  });

  it("returns validation errors without logging clipboard payloads", async () => {
    mockUploadTerminalPasteAssets.mockRejectedValue(new Error("Unsupported paste asset type"));
    const body = new FormData();
    body.append("files", new File(["not-image"], "notes.txt", { type: "text/plain" }));

    const response = await POST(new Request("https://hive.test/upload", { method: "POST", body }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unsupported paste asset type" });
  });
});
