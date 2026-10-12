import { afterEach, describe, expect, it, vi } from "vitest";
import { authServiceHeaders } from "./service-auth";

afterEach(() => vi.unstubAllEnvs());

describe("authServiceHeaders", () => {
  it("uses the dedicated environment secret without accepting a cookie secret fallback", () => {
    vi.stubEnv("AUTH_SERVICE_SECRET", "a".repeat(64));
    vi.stubEnv("COOKIE_SECRET", "b".repeat(64));
    expect(authServiceHeaders()).toEqual({ Authorization: `Bearer ${"a".repeat(64)}` });
    vi.stubEnv("AUTH_SERVICE_SECRET", undefined);
    expect(() => authServiceHeaders()).toThrow(
      "AUTH_SERVICE_SECRET must be exactly 64 hex characters",
    );
  });

  it.each([
    "",
    "replace-me",
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
    ` ${"a".repeat(64)}`,
    `${"a".repeat(64)}\r\nX-Injected: secret`,
  ])("rejects malformed configuration without exposing its value", (secret) => {
    expect(() => authServiceHeaders(secret)).toThrow(
      "AUTH_SERVICE_SECRET must be exactly 64 hex characters (32 bytes)",
    );
  });
});
