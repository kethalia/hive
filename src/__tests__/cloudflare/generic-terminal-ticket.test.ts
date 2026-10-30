import { SECURE_SESSION_COOKIE_NAME, signCookie, verifyTerminalTicket } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: mock.env }) }));
vi.mock("@/lib/auth/session", () => ({
  getRequestSession: vi.fn(() => {
    throw new Error("CF must use bounded private binding");
  }),
}));

import { POST } from "@/app/api/auth/terminal-ticket/route";

const origin = "https://hive.example",
  secret = "b".repeat(64);
const target = `/ws?${new URLSearchParams({ workspaceId: "10000000-0000-4000-8000-000000000001", agentId: "20000000-0000-4000-8000-000000000001", reconnectId: "30000000-0000-4000-8000-000000000001", sessionName: "shell", width: "80", height: "24" })}`;
const session = {
  userId: "40000000-0000-4000-8000-000000000001",
  coderUserId: "50000000-0000-4000-8000-000000000001",
  coderUrl: "https://coder.example",
  sessionId: "fixture-session",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
let auth: ReturnType<typeof vi.fn<typeof fetch>>;
function request(path = target) {
  return new Request(`${origin}/api/auth/terminal-ticket`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: `${SECURE_SESSION_COOKIE_NAME}=${signCookie("fixture-session", secret)}`,
    },
    body: JSON.stringify({ url: `${origin}${path}` }),
  });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
  vi.stubEnv("HIVE_GENERIC_TERMINAL_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "/");
  vi.stubEnv("COOKIE_SECRET", secret);
  auth = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://hive-auth.internal/sessions/fixture-session");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${"a".repeat(64)}`);
    return Response.json(session);
  });
  mock.env = {
    AUTH_SERVICE: { fetch: auth },
    AUTH_SERVICE_SECRET: "a".repeat(64),
    COOKIE_SECRET: secret,
    CODER_URL: "https://coder.example",
  };
});
afterEach(() => vi.unstubAllEnvs());
describe("Cloudflare generic terminal ticket issuer", () => {
  it("uses only current cookie session and issues exact same-origin request-bound admission", async () => {
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(
      verifyTerminalTicket((await result.json()).ticket, secret, {
        audience: "hive.example",
        origin,
        requestTarget: target,
      }),
    ).toMatchObject({ sessionId: "fixture-session" });
    expect(auth).toHaveBeenCalledOnce();
  });
  it.each([
    "/ws/audio",
    "/keepalive/status",
    `${target}&command=id`,
    `${target}&clonePath=repo`,
  ])("never expands generic ticket scope to %s", async (path) => {
    expect((await POST(request(path))).status).toBe(400);
    expect(auth).not.toHaveBeenCalled();
  });
  it("default-off and missing/duplicate owner cookies fail before private auth", async () => {
    vi.stubEnv("HIVE_GENERIC_TERMINAL_ENABLED", "false");
    expect((await POST(request())).status).toBe(404);
    vi.stubEnv("HIVE_GENERIC_TERMINAL_ENABLED", "true");
    const value = request();
    value.headers.delete("Cookie");
    expect((await POST(value)).status).toBe(401);
    const duplicate = request();
    duplicate.headers.append("Cookie", duplicate.headers.get("Cookie") ?? "");
    expect((await POST(duplicate)).status).toBe(401);
    expect(auth).not.toHaveBeenCalled();
  });
  it("expired or malformed private session and aborted request cannot mint", async () => {
    for (const expiresAt of ["invalid", new Date(Date.now() - 1000).toISOString()]) {
      auth.mockResolvedValueOnce(Response.json({ ...session, expiresAt }));
      expect((await POST(request())).status).toBe(401);
    }
    const controller = new AbortController();
    controller.abort();
    expect((await POST(new Request(request(), { signal: controller.signal }))).status).toBe(400);
  });
});
