import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  send: vi.fn(),
  source: vi.fn(),
  processor: null as null | ((job: { data: unknown }) => Promise<void>),
}));
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: mocks.add })),
  Worker: vi.fn().mockImplementation((_name, processor) => {
    mocks.processor = processor;
    return {};
  }),
}));
vi.mock("@/lib/queue/connection", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/push/send", () => ({ sendPushToUser: mocks.send }));
vi.mock("@hive/db", () => ({
  getDb: () => ({ notificationSource: { findUnique: mocks.source } }),
}));

import { createNotificationWorker, enqueueNotification } from "@/lib/push/event-queue";

const data = {
  userId: "user",
  sourceId: "source",
  payload: { title: "Ready", body: "Agent done", tag: "tag" },
};
beforeEach(() => {
  vi.clearAllMocks();
});
describe("notification delivery queue", () => {
  it("deduplicates callback retries but separates sources", async () => {
    await enqueueNotification(data, "event");
    await enqueueNotification(data, "event");
    await enqueueNotification({ ...data, sourceId: "another-source" }, "event");
    expect(mocks.add.mock.calls[0][2].jobId).toBe(mocks.add.mock.calls[1][2].jobId);
    expect(mocks.add.mock.calls[0][2].jobId).not.toBe(mocks.add.mock.calls[2][2].jobId);
  });
  it("drops queued events from revoked sources", async () => {
    createNotificationWorker();
    mocks.source.mockResolvedValue(null);
    await mocks.processor?.({ data });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("allows transient delivery errors to trigger BullMQ retry", async () => {
    createNotificationWorker();
    mocks.source.mockResolvedValue({ id: "source" });
    mocks.send.mockRejectedValue(new Error("transient"));
    await expect(mocks.processor?.({ data })).rejects.toThrow("transient");
    expect(mocks.send).toHaveBeenCalledWith("user", data.payload, true);
  });
});
