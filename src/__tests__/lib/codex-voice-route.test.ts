import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/codex/voice-connection", () => ({ connectWorkspaceCodex: mocks.connect }));
vi.mock("@/lib/codex/voice-session", () => ({
  listVoiceThreads: mocks.list,
  createVoiceStream: mocks.stream,
}));

import { GET, POST } from "@/app/api/workspaces/[workspaceId]/voice/route";

const workspaceId = "00000000-0000-0000-0000-000000000001";
const threadId = "00000000-0000-0000-0000-000000000002";
const context = { params: Promise.resolve({ workspaceId }) };
const url = `https://hive.example/api/workspaces/${workspaceId}/voice`;
const close = vi.fn();
const request = (
  body: unknown = { threadId, sdp: "v=0\r\nm=audio" },
  origin = "https://hive.example",
) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.stubEnv("HIVE_CODEX_VOICE_ENABLED", "true");
  mocks.session.mockResolvedValue({ user: { id: "hive-user" } });
  mocks.connect.mockResolvedValue({ close });
  mocks.list.mockResolvedValue([{ id: threadId }]);
  mocks.stream.mockReturnValue(
    new ReadableStream({
      start(c) {
        c.close();
      },
    }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("voice route boundary", () => {
  it("is disabled by default and rejects unauthenticated and cross-site requests before connecting", async () => {
    vi.stubEnv("HIVE_CODEX_VOICE_ENABLED", "false");
    expect((await POST(request(), context)).status).toBe(404);
    vi.stubEnv("HIVE_CODEX_VOICE_ENABLED", "true");
    mocks.session.mockResolvedValueOnce(null);
    expect((await GET(new Request(url), context)).status).toBe(401);
    expect((await POST(request(undefined, "https://attacker.example"), context)).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("rejects malformed and oversized offers without invoking Codex", async () => {
    expect((await POST(request({ threadId: "../../other", sdp: "offer" }), context)).status).toBe(
      400,
    );
    expect(
      (await POST(request({ threadId, sdp: `v=0\nm=audio${"x".repeat(65536)}` }), context)).status,
    ).toBe(413);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("scopes discovery to the authenticated workspace and always closes its connection", async () => {
    const req = new Request(url);
    expect((await GET(req, context)).status).toBe(200);
    expect(mocks.connect).toHaveBeenCalledWith("hive-user", workspaceId, req.signal);
    expect(close).toHaveBeenCalled();
  });
  it("refuses an unloaded thread and only passes a validated offer to signaling", async () => {
    mocks.list.mockResolvedValueOnce([]);
    expect((await POST(request(), context)).status).toBe(409);
    expect(close).toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
    const req = request();
    const response = await POST(req, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.stream).toHaveBeenCalledWith({ close }, threadId, "v=0\r\nm=audio", req.signal);
  });
});
