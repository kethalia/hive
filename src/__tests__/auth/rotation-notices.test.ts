import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ send: vi.fn(), keys: vi.fn() }));
vi.mock("@/lib/push/fetch-transport", () => ({ sendFetchPush: calls.send }));
vi.mock("@/lib/push/vapid", () => ({ getVapidKeys: calls.keys }));

import { sendTokenWarning } from "@/lib/auth/rotation-notices";

beforeEach(() => {
  vi.clearAllMocks();
  calls.keys.mockResolvedValue({ publicKey: "fixture-public", privateKey: "fixture-private" });
});
const payload = {
  title: "Token expiring",
  body: "Fixture",
  kind: "token" as const,
  url: "/login",
  tag: "fixed-token-warning",
};
function fixture(preferences: Record<string, boolean>) {
  const row = {
    id: "sub",
    userId: "owner",
    endpoint: "https://push.example.invalid/fixture",
    p256dh: "key",
    auth: "auth",
    preferences,
  };
  const db = {
    pushSubscription: { findMany: vi.fn().mockResolvedValue([row]), deleteMany: vi.fn() },
  };
  return {
    row,
    db,
    send: () => sendTokenWarning(db as never, "owner", payload, "mailto:fixture@example.invalid"),
  };
}
it("uses token preferences independently of delivery preferences", async () => {
  const off = fixture({ token: false, delivery: true });
  expect(await off.send()).toBe("delivered");
  expect(calls.send).not.toHaveBeenCalled();
  const on = fixture({ token: true, delivery: false });
  expect(await on.send()).toBe("delivered");
  expect(calls.send).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint: on.row.endpoint }),
    JSON.stringify(payload),
    expect.objectContaining({ TTL: 3600, urgency: "high" }),
  );
});
it("removes a permanently expired subscription only with its exact owner and endpoint", async () => {
  const f = fixture({ token: true });
  calls.send.mockRejectedValue({ statusCode: 410 });
  expect(await f.send()).toBe("delivered");
  expect(f.db.pushSubscription.deleteMany).toHaveBeenCalledWith({
    where: { id: f.row.id, userId: "owner", endpoint: f.row.endpoint },
  });
});
it("push failures are retryable and excessive fanout is explicitly failed", async () => {
  const f = fixture({ token: true });
  calls.send.mockRejectedValue(new Error("private endpoint response"));
  expect(await f.send()).toBe("retry");
  f.db.pushSubscription.findMany.mockResolvedValue(Array.from({ length: 51 }, () => f.row));
  expect(await f.send()).toBe("failed");
});
