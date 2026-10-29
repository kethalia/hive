import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(),
  dispatch: vi.fn(),
  send: vi.fn(),
  db: {},
}));
vi.mock("@hive/db", () => ({ getDb: () => calls.db }));
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: (...args: unknown[]) => calls.create(...args),
}));
vi.mock("@/lib/delivery/dispatch", () => ({
  dispatchNotificationBatch: (...args: unknown[]) => calls.dispatch(...args),
  sendDeliveryPush: (...args: unknown[]) => calls.send(...args),
}));

import worker, { dispatchScheduled } from "../../../../deploy/cloudflare/jobs/worker";

beforeEach(() => {
  vi.clearAllMocks();
  calls.close.mockResolvedValue(undefined);
  calls.create.mockReturnValue({ run: (run: () => unknown) => run(), close: calls.close });
});
describe("scheduled delivery Worker lifetime", () => {
  it("requires explicit activation before creating a database context", async () => {
    expect(await dispatchScheduled({})).toEqual({ enabled: false });
    expect(calls.create).not.toHaveBeenCalled();
    expect((await worker.fetch()).status).toBe(404);
  });
  it("keeps the database open through provider delivery and closes after completion", async () => {
    calls.send.mockResolvedValue("delivered");
    calls.dispatch.mockImplementation(async (db, send) => {
      expect(calls.close).not.toHaveBeenCalled();
      expect(db).toBe(calls.db);
      await send("fixture-owner", { title: "Fixture" });
      expect(calls.close).not.toHaveBeenCalled();
      return { delivered: 1, retry: 0, failed: 0, stale: 0 };
    });
    expect(
      await dispatchScheduled({
        HIVE_DELIVERY_DISPATCH_ENABLED: "true",
        DATABASE_URL: "fixture-url",
        VAPID_SUBJECT: "mailto:fixture@example.invalid",
      }),
    ).toMatchObject({ enabled: true, delivered: 1 });
    expect(calls.send).toHaveBeenCalledWith(
      calls.db,
      "fixture-owner",
      { title: "Fixture" },
      "mailto:fixture@example.invalid",
    );
    expect(calls.close).toHaveBeenCalledOnce();
  });
  it("closes failed invocations without exposing database/provider error details", async () => {
    calls.dispatch.mockRejectedValue(new Error("private database details"));
    await expect(worker.scheduled({}, { HIVE_DELIVERY_DISPATCH_ENABLED: "true" })).rejects.toThrow(
      "Delivery dispatch unavailable",
    );
    expect(calls.close).toHaveBeenCalledOnce();
  });
});
