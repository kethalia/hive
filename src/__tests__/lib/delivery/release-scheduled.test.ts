import { describe, expect, it, vi } from "vitest";
import { runReleaseSchedule } from "../../../../deploy/cloudflare/app/release-scheduled";

describe("release cron activation", () => {
  it("requires both flags and exact owned cron before touching dependencies", async () => {
    const run = vi.fn(async () => {});
    expect(await runReleaseSchedule({ cron: "*/5 * * * *" }, {}, run)).toBe("disabled");
    expect(
      await runReleaseSchedule(
        { cron: "* * * * *" },
        { HIVE_DELIVERY_RELEASE_ENABLED: "true", HIVE_DELIVERY_RELEASE_SCHEDULER_ENABLED: "true" },
        run,
      ),
    ).toBe("disabled");
    expect(run).not.toHaveBeenCalled();
    expect(
      await runReleaseSchedule(
        { cron: "*/5 * * * *" },
        { HIVE_DELIVERY_RELEASE_ENABLED: "true", HIVE_DELIVERY_RELEASE_SCHEDULER_ENABLED: "true" },
        run,
      ),
    ).toBe("complete");
    expect(run).toHaveBeenCalledOnce();
  });
});
