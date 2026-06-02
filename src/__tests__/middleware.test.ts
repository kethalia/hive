import { afterEach, describe, expect, it, vi } from "vitest";

const mockVerifyCookie = vi.hoisted(() => vi.fn());

vi.mock("@hive/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/auth")>()),
  verifyCookie: (...args: unknown[]) => mockVerifyCookie(...args),
}));

import { NextRequest } from "next/server";
import { middleware } from "../middleware";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("middleware", () => {
  it("refreshes a valid session cookie onto COOKIE_DOMAIN", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.local.kethalia.com/templates", {
      headers: {
        cookie: "hive-session=signed-value",
      },
    });

    const response = middleware(request);
    const setCookie = response.headers.get("set-cookie");

    expect(mockVerifyCookie).toHaveBeenCalledWith("signed-value", "test-secret");
    expect(setCookie).toContain("hive-session=signed-value");
    expect(setCookie).toContain("Domain=.hive.local.kethalia.com");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");

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

    const response = middleware(request);
    const setCookie = response.headers.get("set-cookie");

    expect(response.headers.get("location")).toBeNull();
    expect(mockVerifyCookie).toHaveBeenCalledWith("preview-cookie", "preview-secret");
    expect(setCookie).toContain("hive-session=preview-cookie");
    expect(setCookie).toContain("Domain=.pr-101.hive.local.kethalia.com");
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

    const response = middleware(request);
    const setCookie = response.headers.get("set-cookie");

    expect(response.headers.get("location")).toBeNull();
    expect(setCookie).toContain("hive-session=newer-cookie");
    expect(setCookie).not.toContain("hive-session=older-cookie");
  });
});
