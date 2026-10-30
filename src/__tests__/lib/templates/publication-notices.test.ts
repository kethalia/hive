import type { PrismaClient } from "@hive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ send: vi.fn(), keys: vi.fn() }));
vi.mock("@/lib/push/fetch-transport", () => ({ sendFetchPush: mocked.send }));
vi.mock("@/lib/push/vapid", () => ({ getVapidKeys: mocked.keys }));

import {
  sendTemplatePublicationPush,
  TemplatePublicationNotices,
} from "@/lib/templates/publication-notices";

const owner = "11111111-1111-4111-8111-111111111111",
  payload = {
    kind: "template" as const,
    title: "Template published",
    body: "ai-dev-k8s: ready to use",
    tag: "fixed",
    url: "/templates/ai-dev-k8s",
  };
function fixture(count = 1, enabled = true) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    userId: owner,
    endpoint: `https://push.fixture.invalid/${i}`,
    p256dh: "fixture",
    auth: "fixture",
    preferences: { template: enabled },
  }));
  const findMany = vi.fn(async () => rows),
    remove = vi.fn(async () => ({ count: 1 }));
  return {
    db: { pushSubscription: { findMany, deleteMany: remove } } as unknown as PrismaClient,
    findMany,
    remove,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocked.keys.mockResolvedValue({ publicKey: "synthetic", privateKey: "synthetic" });
  mocked.send.mockResolvedValue(undefined);
});
describe("bounded template notice sender", () => {
  it("subscription cap rejects before reading account VAPID keys or sending", async () => {
    const f = fixture(21);
    expect(
      await sendTemplatePublicationPush(f.db, owner, payload, "mailto:fixture@example.invalid"),
    ).toBe("failed");
    expect(mocked.keys).not.toHaveBeenCalled();
    expect(mocked.send).not.toHaveBeenCalled();
    expect(f.findMany).toHaveBeenCalledWith({ where: { userId: owner }, take: 21 });
  });
  it("template preference suppresses delivery without touching credentials", async () => {
    const f = fixture(2, false);
    expect(
      await sendTemplatePublicationPush(f.db, owner, payload, "mailto:fixture@example.invalid"),
    ).toBe("delivered");
    expect(mocked.keys).not.toHaveBeenCalled();
    expect(mocked.send).not.toHaveBeenCalled();
  });
  it("uses only deployment VAPID and fixed generic metadata; gone endpoint removal remains owner scoped", async () => {
    const f = fixture();
    mocked.send.mockRejectedValue({ statusCode: 410 });
    expect(
      await sendTemplatePublicationPush(f.db, owner, payload, "mailto:fixture@example.invalid"),
    ).toBe("delivered");
    expect(f.remove).toHaveBeenCalledWith({
      where: { id: "0", userId: owner, endpoint: "https://push.fixture.invalid/0" },
    });
    expect(mocked.send.mock.calls[0]?.[1]).toBe(JSON.stringify(payload));
    expect(mocked.send.mock.calls[0]?.[2].vapidDetails).toEqual({
      subject: "mailto:fixture@example.invalid",
      publicKey: "synthetic",
      privateKey: "synthetic",
    });
  });
  it("rejects nonfinite or negative internal test timings", () => {
    const f = fixture();
    for (const value of [-1, NaN, Infinity]) {
      expect(() => new TemplatePublicationNotices(f.db, { leaseMs: value })).toThrow();
      expect(() => new TemplatePublicationNotices(f.db, { retryMs: value })).toThrow();
    }
  });
  it("an abort does not let outstanding subscription DB work escape the sender lifetime", async () => {
    let complete!: (rows: unknown[]) => void,
      settled = false;
    const abort = new AbortController();
    const db = {
      pushSubscription: {
        findMany: () =>
          new Promise<unknown[]>((resolve) => {
            complete = resolve;
          }),
      },
    } as unknown as PrismaClient;
    const work = sendTemplatePublicationPush(
      db,
      owner,
      payload,
      "mailto:fixture@example.invalid",
      abort.signal,
    );
    const checked = expect(work).rejects.toBeDefined();
    void work
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    complete([]);
    await checked;
    expect(settled).toBe(true);
    expect(mocked.keys).not.toHaveBeenCalled();
    expect(mocked.send).not.toHaveBeenCalled();
  });
  it("an already-started expired-subscription delete stays in the actual sender lifetime", async () => {
    const f = fixture(),
      abort = new AbortController();
    let finish!: (value: { count: number }) => void,
      settled = false;
    f.remove.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocked.send.mockRejectedValue({ statusCode: 410 });
    const work = sendTemplatePublicationPush(
      f.db,
      owner,
      payload,
      "mailto:fixture@example.invalid",
      abort.signal,
    );
    void work
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    while (!finish) await Promise.resolve();
    abort.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ count: 1 });
    await work;
    expect(settled).toBe(true);
  });
});
