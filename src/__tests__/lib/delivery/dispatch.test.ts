import { createECDH, randomBytes } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";

const getKeys = vi.hoisted(() => vi.fn());
vi.mock("@/lib/push/vapid", () => ({ getVapidKeys: () => getKeys() }));

import { sendDeliveryPush } from "@/lib/delivery/dispatch";

const owner = "11111111-1111-4111-8111-111111111111";
const payload = {
  kind: "delivery" as const,
  title: "Step completed",
  body: "Read report",
  tag: "delivery:fixture",
};
function subscription(id: string, preferences = {}) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    id,
    userId: owner,
    endpoint: `https://push.fixture.invalid/${id}`,
    p256dh: key.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    preferences,
  };
}
function fixture(subscriptions: ReturnType<typeof subscription>[]) {
  const findMany = vi.fn().mockResolvedValue(subscriptions);
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    db: { pushSubscription: { findMany, deleteMany } } as unknown as PrismaClient,
    findMany,
    deleteMany,
  };
}
beforeEach(() => {
  getKeys.mockReset().mockResolvedValue(webpush.generateVAPIDKeys());
});
describe("bounded delivery push fan-out", () => {
  it("honors disabled preferences without requiring VAPID keys or sending", async () => {
    const { db, findMany } = fixture([subscription("disabled", { delivery: false })]);
    const transport = vi.fn();
    expect(await sendDeliveryPush(db, owner, payload, "", transport)).toBe("delivered");
    expect(findMany).toHaveBeenCalledWith({ where: { userId: owner }, take: 51 });
    expect(transport).not.toHaveBeenCalled();
    expect(getKeys).not.toHaveBeenCalled();
  });
  it("retains report retryability when server signing configuration is missing", async () => {
    const { db } = fixture([subscription("one")]);
    expect(await sendDeliveryPush(db, owner, payload, "", vi.fn())).toBe("retry");
    expect(getKeys).not.toHaveBeenCalled();
  });
  it("fails visibly instead of silently dropping subscriptions above the fan-out bound", async () => {
    const { db } = fixture(Array.from({ length: 51 }, (_, i) => subscription(String(i))));
    const transport = vi.fn();
    expect(
      await sendDeliveryPush(db, owner, payload, "mailto:fixture@example.invalid", transport),
    ).toBe("failed");
    expect(transport).not.toHaveBeenCalled();
  });
  it("removes only the exact owner's expired endpoint and retries transient failures", async () => {
    const stale = subscription("stale");
    const { db, deleteMany } = fixture([stale, subscription("good"), subscription("unavailable")]);
    const transport = vi.fn(
      async (input: string | URL | Request) =>
        new Response(null, {
          status: String(input).endsWith("stale")
            ? 410
            : String(input).endsWith("unavailable")
              ? 503
              : 201,
        }),
    );
    expect(
      await sendDeliveryPush(db, owner, payload, "mailto:fixture@example.invalid", transport),
    ).toBe("retry");
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: stale.id, userId: owner, endpoint: stale.endpoint },
    });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("delivers to enabled devices while old preferences default to enabled", async () => {
    const { db } = fixture([
      subscription("old"),
      subscription("disabled", { delivery: false }),
      subscription("new", { delivery: true }),
    ]);
    const transport = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    expect(
      await sendDeliveryPush(db, owner, payload, "mailto:fixture@example.invalid", transport),
    ).toBe("delivered");
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
