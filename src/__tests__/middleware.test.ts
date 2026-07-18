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
    expect(dashboardResponse.headers.get("location")).toBe("https://hive.local.kethalia.com/login");
  });

  it("refreshes a valid session cookie onto COOKIE_DOMAIN", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.local.kethalia.com/templates", {
      headers: {
        cookie: "hive-session=signed-value; hive-coder-host=coder.example.com",
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
      "frame-src 'self' https://coder.example.com https://*.example.com",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "frame-src 'self' https:;",
    );

    vi.unstubAllEnvs();
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
