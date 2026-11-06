import { describe, expect, it } from "vitest";
import { pilotScheduleAllowed } from "../../../deploy/cloudflare/jobs/pilot-schedule";

describe("pilot cron lifetime", () => {
  const start = 1800000000000;
  const env = {
    HIVE_DELIVERY_PILOT_MODE: "true",
    HIVE_DELIVERY_PILOT_SCHEDULE_ENABLED: "true",
    HIVE_DELIVERY_PILOT_SCHEDULE_STARTED_AT: String(start),
    HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL: String(start + 300000),
  };
  it("allows the explicitly bounded interval only", () => {
    expect(pilotScheduleAllowed(env, start)).toBe(true);
    expect(pilotScheduleAllowed(env, start + 299999)).toBe(true);
    expect(pilotScheduleAllowed(env, start - 1)).toBe(false);
    expect(pilotScheduleAllowed(env, start + 300000)).toBe(false);
  });
  it("rejects missing, disabled, malformed and longer than 30 minutes", () => {
    for (const change of [
      { HIVE_DELIVERY_PILOT_MODE: "false" },
      { HIVE_DELIVERY_PILOT_SCHEDULE_ENABLED: "false" },
      { HIVE_DELIVERY_PILOT_SCHEDULE_STARTED_AT: "" },
      { HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL: String(start + 1800001) },
      { HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL: String(start) },
    ])
      expect(pilotScheduleAllowed({ ...env, ...change }, start)).toBe(false);
  });
});
