/** Worker cron gate. No task payload or model can enable or select a release.
 * A deployment must install the exact cron and both operator flags. */
export async function runReleaseSchedule(
  event: { cron: string },
  env: { HIVE_DELIVERY_RELEASE_ENABLED?: string; HIVE_DELIVERY_RELEASE_SCHEDULER_ENABLED?: string },
  run: (signal: AbortSignal) => Promise<unknown>,
) {
  if (
    env.HIVE_DELIVERY_RELEASE_ENABLED !== "true" ||
    env.HIVE_DELIVERY_RELEASE_SCHEDULER_ENABLED !== "true" ||
    event.cron !== "*/5 * * * *"
  )
    return "disabled" as const;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50000);
  try {
    await run(controller.signal);
    return controller.signal.aborted ? ("aborted" as const) : ("complete" as const);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
