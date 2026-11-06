import type { PrismaClient } from "@hive/db";
import { describe, expect, it, vi } from "vitest";
import { ReleaseScheduler } from "@/lib/delivery/release-scheduler.server";

const owner = "00000000-0000-4000-8000-000000000001";
const ids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
describe("release scheduler", () => {
  it("continues after a hold, scopes all selections and rotates cursors", async () => {
    const cursors: string[] = [],
      target = "a".repeat(64);
    let query = 0;
    const db = {
      $queryRaw: async (_strings: TemplateStringsArray, ...params: string[]) => {
        expect(params[0]).toBe(target);
        cursors.push(params[1]);
        query++;
        return query === 1 ? ids.map((id) => ({ id, owner_id: owner })) : [];
      },
    } as unknown as PrismaClient;
    const step = vi.fn().mockRejectedValueOnce(new Error("held")).mockResolvedValue("observed");
    const controller = { step, observe: vi.fn(), builds: { verifyRun: vi.fn() } };
    const scheduler = new ReleaseScheduler(db, target, controller);
    expect(await scheduler.tick(new AbortController().signal)).toEqual({
      status: "complete",
      actions: 1,
      verifications: 0,
      observations: 0,
      held: 1,
    });
    expect(step).toHaveBeenCalledTimes(2);
    await scheduler.tick(new AbortController().signal);
    expect(cursors[3]).toBe(ids[1]);
  });
  it("skips overlapping and already-aborted ticks", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = {
      $queryRaw: async () => {
        await pending;
        return [];
      },
    } as unknown as PrismaClient;
    const scheduler = new ReleaseScheduler(db, "a".repeat(64), {
      step: vi.fn(),
      observe: vi.fn(),
      builds: { verifyRun: vi.fn() },
    });
    const first = scheduler.tick(new AbortController().signal);
    expect(await scheduler.tick(new AbortController().signal)).toEqual({ status: "skipped" });
    const abort = new AbortController();
    abort.abort();
    expect(await scheduler.tick(abort.signal)).toEqual({ status: "skipped" });
    release();
    expect((await first).status).toBe("complete");
  });
});
