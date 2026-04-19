import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit } from "./rate-limit.js";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under limit", () => {
    const result = checkRateLimit("ip-1", 3, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks at limit", () => {
    checkRateLimit("ip-2", 2, 60_000);
    checkRateLimit("ip-2", 2, 60_000);
    const result = checkRateLimit("ip-2", 2, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("resets after window expires", () => {
    checkRateLimit("ip-3", 1, 1000);
    const blocked = checkRateLimit("ip-3", 1, 1000);
    expect(blocked.allowed).toBe(false);

    vi.advanceTimersByTime(1001);
    const result = checkRateLimit("ip-3", 1, 1000);
    expect(result.allowed).toBe(true);
  });

  it("isolates keys", () => {
    checkRateLimit("a", 1, 60_000);
    const result = checkRateLimit("b", 1, 60_000);
    expect(result.allowed).toBe(true);
  });
});
