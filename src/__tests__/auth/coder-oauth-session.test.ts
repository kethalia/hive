import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ getRequestSession: getSession }));

import { GET } from "@/app/api/auth/coder/session/route";

const origin = "https://hive.oauth.invalid";
const sessionId = "d8411ca9-59d9-432b-b9a3-f433da0fbb9c";
function request(headers?: HeadersInit, requestOrigin = origin) {
  return new Request(`${requestOrigin}/api/auth/coder/session`, { headers });
}
function authenticated(id = sessionId) {
  return {
    user: { id: "private-user", email: "private@example.invalid" },
    session: { id, sessionId: id, expiresAt: new Date(Date.now() + 60_000) },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  getSession.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("Coder OAuth browser-session observation", () => {
  it("returns only the SHA-256 fingerprint of the server-verified session UUID", async () => {
    getSession.mockResolvedValue(authenticated());
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.json()).toEqual({
      session: createHash("sha256").update(sessionId).digest("hex"),
    });
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("returns null for an unauthenticated or unavailable server session", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: null });
  });

  it("keeps the same fingerprint on repeated reads and changes it for a new session", async () => {
    getSession.mockResolvedValueOnce(authenticated()).mockResolvedValueOnce(authenticated());
    const first = await (await GET(request())).json();
    expect(await (await GET(request())).json()).toEqual(first);
    getSession.mockResolvedValueOnce(authenticated("241c79ca-1aaf-4264-b22f-c115566e8d02"));
    const next = await (await GET(request())).json();
    expect(next.session).toMatch(/^[a-f0-9]{64}$/);
    expect(next.session).not.toBe(first.session);
  });

  it("accepts a matching optional Origin and same-origin fetch metadata", async () => {
    const response = await GET(request({ Origin: origin, "Sec-Fetch-Site": "same-origin" }));
    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledOnce();
  });

  it.each<{ headers: Record<string, string>; requestOrigin?: string }>([
    { headers: { Origin: "https://foreign.invalid" } },
    { headers: { Origin: "null" } },
    { headers: { "Sec-Fetch-Site": "cross-site" } },
    { headers: { Origin: origin, "Sec-Fetch-Site": "cross-site" } },
    { headers: {}, requestOrigin: "https://foreign.invalid" },
  ])("rejects a foreign request before reading the session %j", async (input) => {
    const response = await GET(request(input.headers, input.requestOrigin));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured public origin before reading the session", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "");
    expect((await GET(request())).status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("stays unavailable when OAuth is disabled", async () => {
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(getSession).not.toHaveBeenCalled();
  });
});
