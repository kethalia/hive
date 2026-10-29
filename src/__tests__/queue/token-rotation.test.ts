import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rotate = vi.hoisted(() => vi.fn());
vi.mock("../../../services/auth/src/auth/token-rotation", () => ({
  rotateCoderCredentials: rotate,
}));
vi.mock("@/lib/queue/connection", () => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: vi.fn() }));

import { processTokenRotation } from "@/lib/queue/token-rotation";

const job = { data: { triggeredAt: "fixture" } } as Parameters<typeof processTokenRotation>[0];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
});
afterEach(() => vi.unstubAllEnvs());
describe("Node token rotation schedule adapter", () => {
  it("drains bounded domain pages without starting another worker or transport", async () => {
    rotate
      .mockResolvedValueOnce({ nextCursor: "cursor" })
      .mockResolvedValueOnce({ nextCursor: null });
    await processTokenRotation(job);
    expect(rotate).toHaveBeenCalledTimes(2);
    expect(rotate.mock.calls[0][0].afterId).toBeUndefined();
    expect(rotate.mock.calls[1][0].afterId).toBe("cursor");
    expect(rotate.mock.calls[0][0].notifyExpiring).toEqual(expect.any(Function));
  });
  it("retains the existing missing-key skip behavior", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    await processTokenRotation(job);
    expect(rotate).not.toHaveBeenCalled();
  });
  it("propagates domain/database failures for BullMQ retries", async () => {
    rotate.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(processTokenRotation(job)).rejects.toThrow("database unavailable");
  });
});
