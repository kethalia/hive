import { describe, expect, it, vi } from "vitest";
import { computeBackoff } from "@/hooks/useTerminalWebSocket";

describe("computeBackoff", () => {
  it("returns base delay for attempt 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = computeBackoff(0);
    expect(delay).toBe(1000);
    vi.restoreAllMocks();
  });

  it("doubles delay for each attempt", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeBackoff(0)).toBe(1000);
    expect(computeBackoff(1)).toBe(2000);
    expect(computeBackoff(2)).toBe(4000);
    expect(computeBackoff(3)).toBe(8000);
    vi.restoreAllMocks();
  });

  it("caps at max delay of 60s", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = computeBackoff(20);
    expect(delay).toBe(60000);
    vi.restoreAllMocks();
  });

  it("adds positive jitter when random > 0.5", () => {
    vi.spyOn(Math, "random").mockReturnValue(1.0);
    const delay = computeBackoff(0);
    expect(delay).toBe(1000 + 500);
    vi.restoreAllMocks();
  });

  it("adds negative jitter when random < 0.5", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    const delay = computeBackoff(0);
    expect(delay).toBe(1000 - 500);
    vi.restoreAllMocks();
  });

  it("never returns negative values", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.0);
    const delay = computeBackoff(0);
    expect(delay).toBeGreaterThanOrEqual(0);
    vi.restoreAllMocks();
  });

  it("produces different values for different attempts", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delays = Array.from({ length: 5 }, (_, i) => computeBackoff(i));
    const unique = new Set(delays);
    expect(unique.size).toBe(5);
    vi.restoreAllMocks();
  });

  it("backoff sequence follows expected pattern", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
    for (let i = 0; i < expected.length; i++) {
      expect(computeBackoff(i)).toBe(expected[i]);
    }
    vi.restoreAllMocks();
  });

  it("caps at 60000 for attempt=50", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeBackoff(50)).toBe(60000);
    vi.restoreAllMocks();
  });

  it("caps at 60000 for attempt=100", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeBackoff(100)).toBe(60000);
    vi.restoreAllMocks();
  });
});
