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
});
