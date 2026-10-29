import { afterEach, describe, expect, it, vi } from "vitest";

const mockVerifyCookie = vi.hoisted(() => vi.fn());

vi.mock("@hive/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/auth")>()),
  verifyCookie: (...args: unknown[]) => mockVerifyCookie(...args),
}));

import { NextRequest } from "next/server";
import { proxy } from "../proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("proxy", () => {
  it("passes only enabled exact native callback POSTs to their own signature handlers", () => {
    const origin = "https://hive.local.kethalia.com";
    const registration = "/api/codex-host/registrations";
    const heartbeat = `${registration}/00000000-0000-4000-8000-000000000001/heartbeat`;
    const request = (path: string, method = "POST", extra: Record<string, string> = {}) =>
      new NextRequest(`${origin}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...extra },
      });
    vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "false");
    expect(proxy(request(registration)).headers.get("location")).toBe(`${origin}/login`);
    vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "true");
    for (const path of [registration, heartbeat]) {
      const response = proxy(request(path));
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-security-policy")).not.toBeNull();
    }
    for (const invalid of [
      request(registration, "GET"),
      request(`${registration}?invalid=1`),
      request("/api/codex-host/%72egistrations"),
      request("/api/projects", "POST"),
      request(registration, "POST", { Origin: origin }),
    ])
      expect(proxy(invalid).headers.get("location")).toBe(`${origin}/login`);
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });
  it("keeps the marketing homepage public without exposing dashboard routes", () => {
    const homepageResponse = proxy(new NextRequest("https://hive.local.kethalia.com/"));
    const dashboardResponse = proxy(new NextRequest("https://hive.local.kethalia.com/workspaces"));

    expect(homepageResponse.headers.get("location")).toBeNull();
    expect(
      homepageResponse.headers.get("x-middleware-request-x-hive-coder-frame-hosts"),
    ).toBeNull();
    expect(dashboardResponse.headers.get("location")).toBe("https://hive.local.kethalia.com/login");
  });

  it("refreshes a valid session cookie onto COOKIE_DOMAIN", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.local.kethalia.com/templates", {
      headers: {
        cookie: "hive-session=signed-value; hive-coder-host=coder.example.com~apps.coder.test",
      },
    });

    const response = proxy(request);
    const setCookie = response.headers.get("set-cookie");

    expect(mockVerifyCookie).toHaveBeenCalledWith("signed-value", "test-secret");
    expect(setCookie).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src 'self' https://coder.example.com https://*.coder.example.com",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "https://apps.coder.test https://*.apps.coder.test",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "frame-src 'self' https:;",
    );
    expect(response.headers.get("permissions-policy")).toContain(
      'clipboard-read=(self "https://coder.example.com" "https://*.coder.example.com"',
    );
    expect(response.headers.get("permissions-policy")).toContain(
      '"https://apps.coder.test" "https://*.apps.coder.test")',
    );
    expect(response.headers.get("x-middleware-request-x-hive-coder-frame-hosts")).toBe(
      "https://coder.example.com~https://apps.coder.test",
    );

    vi.unstubAllEnvs();
  });

  it("allows workspace applications beneath an apex Coder application host", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.example.com/workspaces", {
      headers: { cookie: "hive-session=signed-value; hive-coder-host=example.com" },
    });

    expect(proxy(request).headers.get("content-security-policy")).toContain(
      "https://example.com https://*.example.com",
    );
  });

  it("allows workspace applications beneath a suffix-style Coder application host", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.example.com/workspaces", {
      headers: { cookie: "hive-session=signed-value; hive-coder-host=*--suffix.au.example.com" },
    });
    const policy = proxy(request).headers.get("content-security-policy") ?? "";

    expect(policy).toContain("https://*.au.example.com");
    expect(policy).not.toContain("https://*.*--suffix.au.example.com");
  });

  it("preserves HTTP frame sources stored for a non-TLS Coder deployment", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });
    const frameSources = encodeURIComponent("http://localhost:7080~http://apps.localhost:7080");
    const request = new NextRequest("http://localhost:3000/workspaces", {
      headers: { cookie: `hive-session=signed-value; hive-coder-host=${frameSources}` },
    });

    const policy = proxy(request).headers.get("content-security-policy") ?? "";
    expect(policy).toContain("http://localhost:7080 http://*.localhost:7080");
    expect(policy).toContain("http://apps.localhost:7080 http://*.apps.localhost:7080");
  });

  it.each([
    "hive-session=victim; hive-session=attacker",
    "hive-session=attacker; hive-session=victim",
    "hive-session=same; hive-session=same",
    "hive-session=; hive-session=victim",
  ])("rejects ambiguous cookies without selecting by browser order or timestamp: %s", (cookie) => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "attacker", timestamp: Date.now() });
    const response = proxy(
      new NextRequest("https://hive.example.com/workspaces", { headers: { cookie } }),
    );
    expect(response.headers.get("location")).toBe("https://hive.example.com/login");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it("requires a fresh production login instead of trusting a legacy domain cookie", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    const response = proxy(
      new NextRequest("https://hive.example.com/workspaces", {
        headers: { cookie: "hive-session=legacy-valid" },
      }),
    );
    expect(response.headers.get("location")).toBe("https://hive.example.com/login");
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it("uses the protected cookie even alongside attacker-planted legacy cookies", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "victim", timestamp: Date.now() });
    const response = proxy(
      new NextRequest("https://hive.example.com/workspaces", {
        headers: {
          cookie: "hive-session=attacker; __Host-hive-session=victim; hive-session=another",
        },
      }),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(mockVerifyCookie).toHaveBeenCalledOnce();
    expect(mockVerifyCookie).toHaveBeenCalledWith("victim", "test-secret");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

it("lets discovery routes return their own JSON authentication errors instead of login HTML", () => {
  const response = proxy(new NextRequest("https://hive.example/api/discovery/workspaces"));
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
});
