import { verifyTerminalTicket } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ getRequestSession: session }));

import { POST } from "@/app/api/auth/terminal-ticket/route";

function request(
  url = "wss://terminal.example.com/ws?agentId=agent",
  origin = "https://hive.example.com",
) {
  return new Request("https://hive.example.com/api/auth/terminal-ticket", {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", "");
  vi.stubEnv("COOKIE_SECRET", "ticket-secret");
  vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "wss://terminal.example.com");
  session.mockReset().mockResolvedValue({
    session: { sessionId: "victim-session", expiresAt: new Date(Date.now() + 60_000) },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("terminal ticket issuer", () => {
  it.each([
    "/ws?agentId=agent",
    "/ws/audio?agentId=agent",
    "/keepalive/status",
    "/session-events?after=2",
  ])("binds a no-store credential to %s", async (path) => {
    const response = await POST(request(`https://terminal.example.com${path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { ticket } = await response.json();
    expect(
      verifyTerminalTicket(ticket, "ticket-secret", {
        audience: "terminal.example.com",
        origin: "https://hive.example.com",
        requestTarget: path,
      }),
    ).toMatchObject({ sessionId: "victim-session" });
  });
  it("rejects foreign and missing browser origins before reading the session", async () => {
    for (const origin of [
      "https://attacker.hive.example.com",
      "https://attacker.example.com",
      "null",
      "",
    ]) {
      expect((await POST(request(undefined, origin))).status).toBe(403);
    }
    expect(session).not.toHaveBeenCalled();
  });
  it.each([
    "wss://evil.example/ws",
    "wss://terminal.example.com.evil/ws",
    "wss://user@terminal.example.com/ws",
    "wss://terminal.example.com/admin",
    "wss://terminal.example.com/ws#fragment",
  ])("refuses credentials for unauthorized targets: %s", async (target) => {
    expect((await POST(request(target))).status).toBe(400);
    expect(session).not.toHaveBeenCalled();
  });
  it("requires a current session and refuses plaintext production terminals", async () => {
    session.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);
    vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "ws://terminal.example.com");
    expect((await POST(request("ws://terminal.example.com/ws"))).status).toBe(503);
  });
  it("uses an explicitly configured public origin behind a proxy", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://public.example.com");
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request(undefined, "https://public.example.com"))).status).toBe(200);
  });
  it("supports same-origin terminal path routing without sharing a cookie", async () => {
    vi.stubEnv("NEXT_PUBLIC_TERMINAL_WS_URL", "/terminal");
    const response = await POST(request("wss://hive.example.com/terminal/ws?agentId=agent"));
    const { ticket } = await response.json();
    expect(
      verifyTerminalTicket(ticket, "ticket-secret", {
        audience: "hive.example.com",
        origin: "https://hive.example.com",
        requestTarget: "/ws?agentId=agent",
      }),
    ).not.toBeNull();
  });
});
