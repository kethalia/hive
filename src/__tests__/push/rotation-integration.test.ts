import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rotate = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../../services/auth/src/auth/token-rotation", () => ({
  rotateCoderCredentials: rotate,
}));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: notify }));
vi.mock("@/lib/queue/connection", () => ({ getRedisConnection: vi.fn() }));

import { PUSH_NOTIFICATION_TAG } from "@/lib/constants";
import { processTokenRotation } from "@/lib/queue/token-rotation";

const job = { data: { triggeredAt: "fixture" } } as Parameters<typeof processTokenRotation>[0];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
});
afterEach(() => vi.unstubAllEnvs());
describe("rotation expiry notice Node integration", () => {
  it("routes portable expiry notices through existing push behavior", async () => {
    notify.mockResolvedValue({ sent: 1, cleaned: 0 });
    rotate.mockImplementationOnce(async ({ notifyExpiring }) => {
      await notifyExpiring("owner", 6);
      return { nextCursor: null };
    });
    await processTokenRotation(job);
    expect(notify).toHaveBeenCalledExactlyOnceWith("owner", {
      title: "Token expiring",
      body: "Your Coder API token expires in 6h. Tap to re-authenticate.",
      tag: PUSH_NOTIFICATION_TAG,
      kind: "token",
      url: "/login",
    });
  });
});
