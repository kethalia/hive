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
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", "");
  vi.stubEnv("HIVE_VOICE_ALLOWED_ORIGINS", "");
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
  function forwardedRequest(origin = "https://hive.example") {
    const req = new Request(`https://gitops-origin.example/api/workspaces/${workspaceId}/voice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin,
        "x-forwarded-host": new URL(origin).host,
        "x-forwarded-proto": new URL(origin).protocol.slice(0, -1),
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ threadId, sdp: "v=0\r\nm=audio" }),
    });
    return req;
  }

  it("accepts the configured public origin through the Cloudflare hostname rewrite", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example");
    const req = forwardedRequest();
    expect((await POST(req, context)).status).toBe(200);
    expect(mocks.stream).toHaveBeenCalledWith({ close }, threadId, "v=0\r\nm=audio", req.signal);
  });

  it.each([
    "https://hive.kethalia.com",
    "https://hive.local.kethalia.com",
  ])("accepts the production alias %s behind a proxy", async (origin) => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.kethalia.com");
    vi.stubEnv(
      "HIVE_VOICE_ALLOWED_ORIGINS",
      " https://hive.kethalia.com, https://hive.local.kethalia.com ",
    );
    expect((await POST(forwardedRequest(origin), context)).status).toBe(200);
  });

  it("supports an explicit origin list without a public-origin setting", async () => {
    vi.stubEnv("HIVE_VOICE_ALLOWED_ORIGINS", "https://hive.example, https://local.example");
    expect((await POST(forwardedRequest("https://local.example"), context)).status).toBe(200);
  });

  it.each([
    ["origin", "https://attacker.example"],
    ["origin", "https://hive.local.kethalia.com.attacker.example"],
    ["x-forwarded-host", "hive.kethalia.com"],
    ["x-forwarded-host", "hive.local.kethalia.com, hive.kethalia.com"],
    ["x-forwarded-proto", "http"],
    ["sec-fetch-site", "cross-site"],
  ])("rejects mismatched alias metadata: %s=%s", async (header, value) => {
    vi.stubEnv(
      "HIVE_VOICE_ALLOWED_ORIGINS",
      "https://hive.kethalia.com,https://hive.local.kethalia.com",
    );
    const req = forwardedRequest("https://hive.local.kethalia.com");
    req.headers.set(header, value);
    expect((await POST(req, context)).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    "not a URL",
    "https://local.example/path",
    "https://user@local.example",
    "https://local.example/?q=1",
    "https://local.example/#fragment",
    "ftp://local.example",
  ])("fails closed on malformed allowlist entry: %s", async (entry) => {
    vi.stubEnv("HIVE_VOICE_ALLOWED_ORIGINS", `https://hive.example,${entry}`);
    expect((await POST(forwardedRequest(), context)).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("does not trust forwarded headers without a configured matching public origin", async () => {
    expect((await POST(forwardedRequest(), context)).status).toBe(403);
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example");
    expect((await POST(forwardedRequest("https://attacker.example"), context)).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["x-forwarded-host", "attacker.example"],
    ["x-forwarded-host", "hive.example, attacker.example"],
    ["x-forwarded-proto", "http"],
    ["x-forwarded-proto", "https, http"],
    ["origin", "null"],
    ["sec-fetch-site", "cross-site"],
  ])("rejects mismatching forwarded origin metadata: %s=%s", async (header, value) => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example");
    const req = forwardedRequest();
    req.headers.set(header, value);
    expect((await POST(req, context)).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    "origin",
    "x-forwarded-host",
    "x-forwarded-proto",
  ])("requires %s on forwarded requests", async (header) => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example");
    const req = forwardedRequest();
    req.headers.delete(header);
    expect((await POST(req, context)).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    "not a URL",
    "https://hive.example/path",
    "https://user@hive.example",
    "https://hive.example/?query=1",
  ])("fails closed on invalid public-origin configuration: %s", async (configured) => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", configured);
    expect((await POST(forwardedRequest(), context)).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("preserves direct same-origin access when a public origin is configured", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://public.example");
    expect((await POST(request(), context)).status).toBe(200);
  });

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
