import type { PrismaClient } from "@hive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ send: vi.fn(), keys: vi.fn() }));
vi.mock("@/lib/push/fetch-transport", () => ({ sendFetchPush: mocked.send }));
vi.mock("@/lib/push/vapid", () => ({ getVapidKeys: mocked.keys }));

import { sendBoundedPush } from "@/lib/push/bounded-send";

const owner = "11111111-1111-4111-8111-111111111111";
const payload = {
  kind: "approval" as const,
  title: "Approval needed",
  body: "Codex is waiting",
  tag: "stable",
  url: "/workspaces?workspace=fixture",
};
function fixture(preferences: Record<string, boolean>[]) {
  const rows = preferences.map((value, i) => ({
    id: String(i),
    endpoint: `https://push.fixture.invalid/${i}`,
    preferences: value,
    p256dh: "synthetic",
    auth: "synthetic",
  }));
  const findMany = vi.fn(async () => rows),
    deleteMany = vi.fn(async () => ({ count: 1 }));
  return {
    db: { pushSubscription: { findMany, deleteMany } } as unknown as PrismaClient,
    findMany,
    deleteMany,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocked.send.mockResolvedValue(undefined);
  mocked.keys.mockResolvedValue({ publicKey: "synthetic", privateKey: "synthetic" });
});
describe("shared bounded agent push transport", () => {
  it("honors the actual event preference independently of template/delivery preferences", async () => {
    const f = fixture([
      { approval: false, template: true },
      { approval: true, template: false },
      {},
    ]);
    expect(await sendBoundedPush(f.db, owner, payload, "mailto:fixture@example.invalid")).toBe(
      "delivered",
    );
    expect(mocked.send).toHaveBeenCalledTimes(2);
    expect(mocked.send.mock.calls[0][2].urgency).toBe("high");
    expect(mocked.send.mock.calls[0][1]).toBe(JSON.stringify(payload));
  });
  it("does not require keys when all event preferences are disabled", async () => {
    expect(await sendBoundedPush(fixture([{ approval: false }]).db, owner, payload, "")).toBe(
      "delivered",
    );
    expect(mocked.keys).not.toHaveBeenCalled();
    expect(mocked.send).not.toHaveBeenCalled();
  });
  it("fails above twenty subscriptions and cleans only the exact owner's expired endpoint", async () => {
    expect(
      await sendBoundedPush(fixture(Array.from({ length: 21 }, () => ({}))).db, owner, payload, ""),
    ).toBe("failed");
    expect(mocked.send).not.toHaveBeenCalled();
    const f = fixture([{}]);
    mocked.send.mockRejectedValueOnce({ statusCode: 410 });
    expect(await sendBoundedPush(f.db, owner, payload, "mailto:fixture@example.invalid")).toBe(
      "delivered",
    );
    expect(f.deleteMany).toHaveBeenCalledWith({
      where: { id: "0", userId: owner, endpoint: "https://push.fixture.invalid/0" },
    });
  });
});
