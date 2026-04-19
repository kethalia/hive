import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkRateLimit } from "@hive/auth";
import { loginRateLimiter } from "../../lib/auth/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("allows requests under the limit", () => {
    const result = checkRateLimit("test-ip-1", 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("allows exactly up to the limit", () => {
    for (let i = 0; i < 4; i++) {
      checkRateLimit("test-ip-2", 5, 60_000);
    }
    const fifth = checkRateLimit("test-ip-2", 5, 60_000);
    expect(fifth.allowed).toBe(true);
    expect(fifth.remaining).toBe(0);
  });

  it("rejects the request exceeding the limit", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-ip-3", 5, 60_000);
    }
    const sixth = checkRateLimit("test-ip-3", 5, 60_000);
    expect(sixth.allowed).toBe(false);
    expect(sixth.remaining).toBe(0);
    expect(sixth.resetMs).toBeGreaterThan(0);
  });

  it("resets after the window expires", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-ip-4", 5, 60_000);
    }

    vi.advanceTimersByTime(60_001);

    const afterReset = checkRateLimit("test-ip-4", 5, 60_000);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(4);
  });

  it("uses sliding window — partial expiry allows some requests", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("test-ip-5", 5, 60_000);
    }

    vi.advanceTimersByTime(30_000);

    for (let i = 0; i < 2; i++) {
      checkRateLimit("test-ip-5", 5, 60_000);
    }

    const result = checkRateLimit("test-ip-5", 5, 60_000);
    expect(result.allowed).toBe(false);

    vi.advanceTimersByTime(30_001);

    const afterPartialExpiry = checkRateLimit("test-ip-5", 5, 60_000);
    expect(afterPartialExpiry.allowed).toBe(true);
  });

  it("isolates different keys", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("ip-a", 5, 60_000);
    }

    const otherIp = checkRateLimit("ip-b", 5, 60_000);
    expect(otherIp.allowed).toBe(true);
    expect(otherIp.remaining).toBe(4);
  });
});

describe("loginRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("enforces 5 attempts per minute", () => {
    for (let i = 0; i < 5; i++) {
      const r = loginRateLimiter.check("limiter-ip");
      expect(r.allowed).toBe(true);
    }

    const sixth = loginRateLimiter.check("limiter-ip");
    expect(sixth.allowed).toBe(false);
  });
});
