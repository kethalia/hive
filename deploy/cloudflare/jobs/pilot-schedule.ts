export function pilotScheduleAllowed(
  env: {
    HIVE_DELIVERY_PILOT_MODE?: string;
    HIVE_DELIVERY_PILOT_SCHEDULE_ENABLED?: string;
    HIVE_DELIVERY_PILOT_SCHEDULE_STARTED_AT?: string;
    HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL?: string;
  },
  now = Date.now(),
) {
  if (
    env.HIVE_DELIVERY_PILOT_MODE !== "true" ||
    env.HIVE_DELIVERY_PILOT_SCHEDULE_ENABLED !== "true"
  )
    return false;
  const rawStart = env.HIVE_DELIVERY_PILOT_SCHEDULE_STARTED_AT ?? "",
    rawEnd = env.HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL ?? "";
  if (!/^\d{13}$/.test(rawStart) || !/^\d{13}$/.test(rawEnd)) return false;
  const start = Number(rawStart),
    end = Number(rawEnd);
  return start <= now && now < end && end - start <= 30 * 60 * 1000 && end > start;
}
