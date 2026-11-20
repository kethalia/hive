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

describe("proxy", async () => {
  it.each([
    "codex-account",
    "claude-account",
  ])("lets the %s route return its own authenticated JSON response", async (provider) => {
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
    const response = await proxy(
      new NextRequest(`https://hive.example.com/api/workspaces/workspace-id/${provider}`, {
        method: "POST",
      }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });
  it.each([
    "__Host-hive-auth=stale",
    "__Host-hive-auth=one; __Host-hive-auth=two",
  ])("ignores disabled OAuth cookies while admitting the protected legacy cookie: %s", async (stale) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example.com");
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "legacy-session", timestamp: Date.now() });
    const response = await proxy(
      new NextRequest("https://hive.example.com/workspaces", {
        headers: { cookie: `${stale}; __Host-hive-session=signed-legacy` },
      }),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    expect(mockVerifyCookie).toHaveBeenCalledWith("signed-legacy", "test-secret");
  });

  it("keeps enabled OAuth authoritative over a valid legacy cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example.com");
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    const response = await proxy(
      new NextRequest("https://hive.example.com/workspaces", {
        headers: { cookie: "__Host-hive-auth=stale; __Host-hive-session=signed-legacy" },
      }),
    );
    expect(response.headers.get("location")).toBe("https://hive.example.com/login");
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it("keeps the marketing homepage public without exposing dashboard routes", async () => {
    const homepageResponse = await proxy(new NextRequest("https://hive.local.kethalia.com/"));
    const dashboardResponse = await proxy(
      new NextRequest("https://hive.local.kethalia.com/workspaces"),
    );

    expect(homepageResponse.headers.get("location")).toBeNull();
    expect(
      homepageResponse.headers.get("x-middleware-request-x-hive-coder-frame-hosts"),
    ).toBeNull();
    expect(dashboardResponse.headers.get("location")).toBe("https://hive.local.kethalia.com/login");
  });

  it("refreshes a valid session cookie onto COOKIE_DOMAIN", async () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.local.kethalia.com/templates", {
      headers: {
        cookie: "hive-session=signed-value; hive-coder-host=coder.example.com~apps.coder.test",
      },
    });

    const response = await proxy(request);
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

  it("allows workspace applications beneath an apex Coder application host", async () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.example.com/workspaces", {
      headers: { cookie: "hive-session=signed-value; hive-coder-host=example.com" },
    });

    expect((await proxy(request)).headers.get("content-security-policy")).toContain(
      "https://example.com https://*.example.com",
    );
  });

  it("allows workspace applications beneath a suffix-style Coder application host", async () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.example.com/workspaces", {
      headers: { cookie: "hive-session=signed-value; hive-coder-host=*--suffix.au.example.com" },
    });
    const policy = (await proxy(request)).headers.get("content-security-policy") ?? "";

    expect(policy).toContain("https://*.au.example.com");
    expect(policy).not.toContain("https://*.*--suffix.au.example.com");
  });

  it("preserves HTTP frame sources stored for a non-TLS Coder deployment", async () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });
    const frameSources = encodeURIComponent("http://localhost:7080~http://apps.localhost:7080");
    const request = new NextRequest("http://localhost:3000/workspaces", {
      headers: { cookie: `hive-session=signed-value; hive-coder-host=${frameSources}` },
    });

    const policy = (await proxy(request)).headers.get("content-security-policy") ?? "";
    expect(policy).toContain("http://localhost:7080 http://*.localhost:7080");
    expect(policy).toContain("http://apps.localhost:7080 http://*.apps.localhost:7080");
  });

  it.each([
    "hive-session=victim; hive-session=attacker",
    "hive-session=attacker; hive-session=victim",
    "hive-session=same; hive-session=same",
    "hive-session=; hive-session=victim",
  ])("rejects ambiguous cookies without selecting by browser order or timestamp: %s", async (cookie) => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "attacker", timestamp: Date.now() });
    const response = await proxy(
      new NextRequest("https://hive.example.com/workspaces", { headers: { cookie } }),
    );
    expect(response.headers.get("location")).toBe("https://hive.example.com/login");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it("requires a fresh production login instead of trusting a legacy domain cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    const response = await proxy(
      new NextRequest("https://hive.example.com/workspaces", {
        headers: { cookie: "hive-session=legacy-valid" },
      }),
    );
    expect(response.headers.get("location")).toBe("https://hive.example.com/login");
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it("uses the protected cookie even alongside attacker-planted legacy cookies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "victim", timestamp: Date.now() });
    const response = await proxy(
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

it.each([
  "/api/discovery/workspaces",
  "/api/projects",
])("lets %s return its own JSON authentication errors", async (path) => {
  const response = await proxy(new NextRequest(`https://hive.example${path}`));
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
});
