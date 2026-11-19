import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/github/connection/route";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  client: vi.fn(),
  status: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mocks.client }));
const origin = "https://hive.example";
const url = `${origin}/api/github/connection`;
const post = (body: object, from = origin) =>
  POST(
    new Request(url, {
      method: "POST",
      headers: { origin: from, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
describe("GitHub connection for the signed-in Coder user", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
    vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
    mocks.session.mockResolvedValue({ user: { id: "owner" }, session: { id: "session1" } });
    mocks.client.mockResolvedValue({
      getGitHubConnection: mocks.status,
      startGitHubDeviceFlow: mocks.start,
      exchangeGitHubDeviceCode: mocks.poll,
      getBaseUrl: () => "https://coder.example",
    });
    mocks.start.mockResolvedValue({
      verification_uri: "https://github.com/login/device",
      user_code: "AAAA-BBBB",
      device_code: "private-device-secret",
      interval: 5,
      expires_in: 600,
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it.each([
    true,
    false,
  ])("only exposes current connection metadata (connected=%s)", async (connected) => {
    mocks.status.mockResolvedValue({
      authenticated: connected,
      device: true,
      user: { login: "octocat" },
      access_token: "private",
    });
    const r = await GET(new Request(url));
    expect(await r.json()).toEqual({
      connected,
      login: connected ? "octocat" : null,
      authorizeUrl: null,
    });
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(mocks.client).toHaveBeenCalledWith("owner", expect.anything());
  });
  it("offers the Coder authorization URL for browser OAuth", async () => {
    mocks.status.mockResolvedValue({ authenticated: true, device: false });
    expect((await (await GET(new Request(url))).json()).authorizeUrl).toBe(
      "https://coder.example/external-auth/github/callback",
    );
  });
  it.each([
    "pending",
    "slow_down",
    "denied",
    "expired",
    "approved",
  ])("relays the exchange outcome %s", async (state) => {
    const pending = await (await post({ action: "start" })).json();
    expect(JSON.stringify(pending)).not.toContain("private-device-secret");
    mocks.poll.mockResolvedValue(state);
    expect(await (await post({ action: "poll", attempt: pending.attempt })).json()).toEqual({
      state,
    });
    expect(mocks.poll).toHaveBeenCalledWith("private-device-secret");
  });
  it("rejects an expired attempt and an attempt from a different session", async () => {
    vi.useFakeTimers();
    const pending = await (await post({ action: "start" })).json();
    mocks.session.mockResolvedValueOnce({ user: { id: "owner" }, session: { id: "other" } });
    expect((await post({ action: "poll", attempt: pending.attempt })).status).toBe(403);
    vi.setSystemTime(pending.expiresAt);
    expect(await (await post({ action: "poll", attempt: pending.attempt })).json()).toEqual({
      state: "expired",
    });
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it("rejects unsolicited mutations, forged attempts and an untrusted provider URL", async () => {
    expect((await post({ action: "start" }, "https://elsewhere.example")).status).toBe(403);
    expect((await post({ action: "poll", attempt: "wrong" })).status).toBe(400);
    mocks.start.mockResolvedValue({
      verification_uri: "https://elsewhere.example",
      device_code: "secret",
      user_code: "ABCD-EFGH",
      interval: 5,
      expires_in: 900,
    });
    expect((await post({ action: "start" })).status).toBe(502);
    mocks.session.mockResolvedValue(null);
    expect((await post({ action: "start" })).status).toBe(401);
  });
});
