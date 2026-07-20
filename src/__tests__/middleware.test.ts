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
  it("keeps the marketing homepage public without exposing dashboard routes", () => {
    const homepageResponse = proxy(new NextRequest("https://hive.local.kethalia.com/"));
    const dashboardResponse = proxy(new NextRequest("https://hive.local.kethalia.com/tasks"));

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
    expect(setCookie).toContain("hive-session=signed-value");
    expect(setCookie).toContain("Domain=.hive.local.kethalia.com");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
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

  it("accepts a valid scoped cookie when a stale parent-domain cookie with the same name is last", () => {
    vi.stubEnv("COOKIE_SECRET", "preview-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".pr-101.hive.local.kethalia.com");
    mockVerifyCookie.mockImplementation((value) =>
      value === "preview-cookie" ? { sessionId: "sess-preview", timestamp: Date.now() } : null,
    );

    const request = new NextRequest("https://pr-101.hive.local.kethalia.com/tasks", {
      headers: {
        cookie: "hive-session=preview-cookie; hive-session=prod-cookie",
      },
    });

    const response = proxy(request);
    const setCookie = response.headers.get("set-cookie");

    expect(response.headers.get("location")).toBeNull();
    expect(mockVerifyCookie).toHaveBeenCalledWith("preview-cookie", "preview-secret");
    expect(setCookie).toContain("hive-session=preview-cookie");
    expect(setCookie).toContain("Domain=.pr-101.hive.local.kethalia.com");
  });

  it("derives preview cookie domain when refreshing without COOKIE_DOMAIN", () => {
    vi.stubEnv("COOKIE_SECRET", "preview-secret");
    vi.stubEnv("COOKIE_DOMAIN", "");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-preview", timestamp: Date.now() });

    const request = new NextRequest("https://pr-113.hive.local.kethalia.com/tasks", {
      headers: {
        cookie: "hive-session=preview-cookie",
      },
    });

    const response = proxy(request);
    const setCookie = response.headers.get("set-cookie");

    expect(response.headers.get("location")).toBeNull();
    expect(mockVerifyCookie).toHaveBeenCalledWith("preview-cookie", "preview-secret");
    expect(setCookie).toContain("hive-session=preview-cookie");
    expect(setCookie).toContain("Domain=.pr-113.hive.local.kethalia.com");
  });

  it("does not derive a cookie domain for localhost", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    vi.stubEnv("COOKIE_DOMAIN", "");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-local", timestamp: Date.now() });

    const request = new NextRequest("http://localhost:3000/tasks", {
      headers: {
        cookie: "hive-session=local-cookie",
      },
    });

    const response = proxy(request);

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refreshes the newest verified duplicate session cookie deterministically", () => {
    vi.stubEnv("COOKIE_SECRET", "preview-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".pr-101.hive.local.kethalia.com");
    const now = Date.now();
    mockVerifyCookie.mockImplementation((value) => {
      if (value === "older-cookie") return { sessionId: "sess-older", timestamp: now - 1000 };
      if (value === "newer-cookie") return { sessionId: "sess-newer", timestamp: now };
      return null;
    });

    const request = new NextRequest("https://pr-101.hive.local.kethalia.com/tasks", {
      headers: {
        cookie: "hive-session=older-cookie; hive-session=newer-cookie",
      },
    });

    const response = proxy(request);
    const setCookie = response.headers.get("set-cookie");

    expect(response.headers.get("location")).toBeNull();
    expect(setCookie).toContain("hive-session=newer-cookie");
    expect(setCookie).not.toContain("hive-session=older-cookie");
  });
});
