import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/auth/service-client", () => ({
  getAuthServiceClient: () => ({ disconnectCoderOAuth: mocks.disconnect }),
}));

import { POST } from "@/app/api/auth/coder/disconnect/route";

const origin = "https://hive.example",
  sid = "10000000-0000-4000-8000-000000000001";
const input = { credentialId: "20000000-0000-4000-8000-000000000001", version: 2 };
function request(body: unknown = input, headers: HeadersInit = {}) {
  return new Request(`${origin}/api/auth/coder/disconnect`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  vi.stubEnv("CODER_URL", "https://coder.example");
  vi.stubEnv("HIVE_CODER_OAUTH_CLIENT_ID", "30000000-0000-4000-8000-000000000001");
  vi.stubEnv("HIVE_CODER_OAUTH_CLIENT_SECRET", "synthetic-client-secret");
  mocks.session.mockResolvedValue({ user: { id: "owner" }, session: { sessionId: sid } });
  mocks.disconnect.mockResolvedValue({
    status: "disconnected",
    providerRevocation: "acknowledged",
    currentConnection: "changed",
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("owner-scoped Coder disconnect POST", () => {
  it("uses server session authority and never clears or redirects a newer login cookie", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.disconnect).toHaveBeenCalledWith(sid, input, expect.any(AbortSignal));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([
    { Origin: "https://evil.invalid" },
    { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" },
  ])("rejects CSRF before session/provider access %j", async (headers) => {
    expect(
      (
        await POST(
          request(
            input,
            Object.fromEntries(
              Object.entries(headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, userId: "foreign" },
    { ...input, coderUrl: "https://evil.invalid" },
    { ...input, version: 0 },
    { ...input, credentialId: "invalid" },
    { ...input, padding: "x".repeat(1024) },
  ])("rejects malformed or caller-selected authority", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
  it("rejects a missing session and maps stale/replay responses without leaking service details", async () => {
    mocks.session.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.disconnect).not.toHaveBeenCalled();
    mocks.disconnect.mockRejectedValueOnce(new Error("coder_disconnect_changed"));
    expect((await POST(request())).status).toBe(409);
    mocks.disconnect.mockRejectedValueOnce(new Error("private database credential"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});
