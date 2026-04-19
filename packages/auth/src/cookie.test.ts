import { describe, it, expect } from "vitest";
import { signCookie, verifyCookie } from "./cookie.js";

const SECRET = "test-secret-key-for-hmac-signing";

describe("signCookie / verifyCookie", () => {
  it("round-trips: sign then verify returns correct sessionId and timestamp", () => {
    const sessionId = "abc-123-def";
    const cookie = signCookie(sessionId, SECRET);
    const result = verifyCookie(cookie, SECRET);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(sessionId);
    expect(typeof result!.timestamp).toBe("number");
    expect(result!.timestamp).toBeGreaterThan(0);
  });

  it("returns null for tampered sessionId", () => {
    const cookie = signCookie("original-id", SECRET);
    const tampered = cookie.replace("original-id", "tampered-id");
    expect(verifyCookie(tampered, SECRET)).toBeNull();
  });

  it("returns null for tampered timestamp", () => {
    const cookie = signCookie("session-1", SECRET);
    const parts = cookie.split(".");
    parts[1] = "9999999999999";
    expect(verifyCookie(parts.join("."), SECRET)).toBeNull();
  });

  it("returns null for tampered HMAC", () => {
    const cookie = signCookie("session-1", SECRET);
    const parts = cookie.split(".");
    parts[2] = "a".repeat(64);
    expect(verifyCookie(parts.join("."), SECRET)).toBeNull();
  });

  it("returns null for wrong secret", () => {
    const cookie = signCookie("session-1", SECRET);
    expect(verifyCookie(cookie, "wrong-secret")).toBeNull();
  });

  it("returns null for malformed cookie (missing parts)", () => {
    expect(verifyCookie("only-one-part", SECRET)).toBeNull();
    expect(verifyCookie("two.parts", SECRET)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(verifyCookie("", SECRET)).toBeNull();
  });

  it("returns null for non-numeric timestamp", () => {
    const cookie = signCookie("session-1", SECRET);
    const parts = cookie.split(".");
    parts[1] = "not-a-number";
    expect(verifyCookie(parts.join("."), SECRET)).toBeNull();
  });

  it("returns null for completely random string", () => {
    expect(verifyCookie("random-garbage-string-here", SECRET)).toBeNull();
  });
});
