import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validCoderAuthCookie } from "@/lib/auth/better-auth-cookie";

const secret = "fixture-cookie-secret-".repeat(3);
beforeEach(() => vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.oauth.invalid"));
afterEach(() => vi.unstubAllEnvs());
describe("Better Auth cookie admission", () => {
  it("validates the framework signature with its own crypto implementation", async () => {
    const token = "framework-session-token";
    const signed = encodeURIComponent(`${token}.${await makeSignature(token, secret)}`);
    expect(await validCoderAuthCookie(`__Host-hive-auth=${signed}`, secret)).toBe(true);
    expect(await validCoderAuthCookie(`__Host-hive-auth=${signed}`, "another-secret")).toBe(false);
  });
  it.each([
    "__Host-hive-auth=a; __Host-hive-auth=b",
    "__Host-hive-auth=a; __Host-hive-auth=a",
    "__Host-hive-auth=; __Host-hive-auth=b",
    "__Host-hive-auth=%invalid",
    "hive-auth=unsigned",
  ])("rejects malformed or ambiguous cookie %s", async (header) => {
    expect(await validCoderAuthCookie(header, secret)).toBe(false);
  });
});
