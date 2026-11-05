import { PrismaClient } from "@hive/db";
import { describe, expect, it, vi } from "vitest";
import { ReleaseScheduler } from "@/lib/delivery/release-scheduler.server";

const url = process.env.HIVE_RELEASE_JOURNAL_TEST_DATABASE_URL;
describe.skipIf(!url)("release scheduler isolated PostgreSQL", () => {
  it("queries all journal classes without touching an unrelated target", async () => {
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      const step = vi.fn(),
        observe = vi.fn(),
        verifyRun = vi.fn();
      const scheduler = new ReleaseScheduler(db, "0".repeat(64), {
        step,
        observe,
        builds: { verifyRun },
      });
      expect(await scheduler.tick(new AbortController().signal)).toEqual({
        status: "complete",
        actions: 0,
        verifications: 0,
        observations: 0,
        held: 0,
      });
      expect(step).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(verifyRun).not.toHaveBeenCalled();
    } finally {
      await db.$disconnect();
    }
  });
});
