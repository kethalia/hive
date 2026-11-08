import type { Prisma, PrismaClient } from "@hive/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseReportClient } from "@/lib/delivery/database-job-installed.server";

afterEach(() => vi.useRealTimers());
describe("bounded post-response database references", () => {
  it("rejects captured delegate and raw-query calls after deadline or cancellation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const query = vi.fn(),
      find = vi.fn(),
      controller = new AbortController();
    const client = databaseReportClient(
      { $queryRaw: query, deliveryEvent: { findFirst: find } } as unknown as PrismaClient,
      controller.signal,
      2000,
    );
    const capturedQuery = client.$queryRaw,
      capturedFind = client.deliveryEvent.findFirst;
    vi.setSystemTime(2000);
    expect(() => capturedQuery`SELECT 1`).toThrow("database_report_expired");
    expect(() => capturedFind({})).toThrow("database_report_expired");
    expect(query).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    vi.setSystemTime(1000);
    controller.abort();
    expect(() => capturedQuery`SELECT 1`).toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("caps SQL transaction acquisition and execution, then rechecks after a queued acquisition", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const query = vi.fn(),
      body = vi.fn((tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT 1`);
    let queued!: () => unknown;
    const transaction = vi.fn(
      (operation: (tx: unknown) => unknown, _options?: unknown) =>
        new Promise((resolve, reject) => {
          queued = () => {
            try {
              resolve(operation({ $queryRaw: query }));
            } catch (error) {
              reject(error);
            }
          };
        }),
    );
    const client = databaseReportClient(
      { $transaction: transaction } as unknown as PrismaClient,
      new AbortController().signal,
      5000,
    );
    const pending = client.$transaction(body, { timeout: 600000, maxWait: 600000 });
    expect(transaction.mock.calls[0][1]).toMatchObject({ maxWait: 2000, timeout: 2000 });
    vi.setSystemTime(5000);
    queued();
    await expect(pending).rejects.toThrow("database_report_expired");
    expect(body).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
