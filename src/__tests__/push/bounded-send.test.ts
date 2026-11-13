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
  const findMany = vi.fn(async (query: { cursor?: { id: string } }) => {
      const offset = query.cursor ? rows.findIndex((row) => row.id === query.cursor!.id) + 1 : 0;
      return rows.slice(offset, offset + 20);
    }),
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
  it("honors the actual event preference independently of template preferences", async () => {
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
  it("paginates existing subscriptions with at most five simultaneous sends", async () => {
    const f = fixture(Array.from({ length: 23 }, () => ({})));
    let active = 0,
      maximum = 0;
    mocked.send.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
    });
    expect(await sendBoundedPush(f.db, owner, payload, "https://hive.invalid")).toBe("delivered");
    expect(f.findMany).toHaveBeenCalledTimes(2);
    expect(mocked.send).toHaveBeenCalledTimes(23);
    expect(maximum).toBe(5);
  });
  it("cleans only the exact owner's expired endpoint", async () => {
    const f = fixture([{}]);
    mocked.send.mockRejectedValueOnce({ statusCode: 410 });
    expect(await sendBoundedPush(f.db, owner, payload, "mailto:fixture@example.invalid")).toBe(
      "delivered",
    );
    expect(f.deleteMany).toHaveBeenCalledWith({
      where: { id: "0", userId: owner, endpoint: "https://push.fixture.invalid/0" },
    });
  });
  it("checks the absolute deadline before network admission even when signing delays timers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const transport = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", transport);
    try {
      const deadline = Date.now() + 30;
      mocked.send.mockImplementationOnce(
        async (_subscription, _body, _options, fetcher: typeof fetch) => {
          vi.setSystemTime(deadline + 1);
          return fetcher("https://push.fixture.invalid/late", {});
        },
      );
      expect(
        await sendBoundedPush(
          fixture([{}]).db,
          owner,
          payload,
          "https://hive.invalid",
          new AbortController().signal,
          deadline,
        ),
      ).toBe("retry");
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
