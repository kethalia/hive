// Compose services inside this invocation: a Preview must never inherit another
// Worker's production service binding or another invocation's environment.
export function createNativeWorker({ app, auth, jobs }) {
  function wired(env, context) {
    const local = { ...env };
    const call = (handler) => (input, init) => {
      const request = new Request(input, init);
      return handler.fetch(request, local, context);
    };
    local.AUTH_SERVICE = { fetch: call(auth) };
    local.APP_SERVICE = { fetch: call(app) };
    return local;
  }
  const active = (env) =>
    (env.HIVE_NATIVE_MODE === "production" && env.HIVE_NATIVE_PRODUCTION_ACTIVE === "true") ||
    (env.HIVE_NATIVE_MODE === "preview" && env.HIVE_NATIVE_PREVIEW_ENABLED === "true");
  return {
    fetch(request, env, context) {
      if (!active(env))
        return new Response("deployment_pending", {
          status: 503,
          headers: {
            "cache-control": "private, no-store",
            "content-type": "text/plain; charset=utf-8",
          },
        });
      return app.fetch(request, wired(env, context), context);
    },
    scheduled(event, env, context) {
      if (
        env.HIVE_NATIVE_MODE !== "production" ||
        env.HIVE_NATIVE_PRODUCTION_ACTIVE !== "true" ||
        !["* * * * *", "*/5 * * * *"].includes(event?.cron)
      )
        return;
      const local = wired(env, context);
      // Distinct cron expressions route each handler exactly once even when
      // their schedules coincide. The app registers its own waitUntil.
      const handlers = event.cron === "* * * * *" ? [jobs] : [app, auth];
      context.waitUntil(
        Promise.allSettled(
          handlers.map((handler) =>
            Promise.resolve().then(() => handler.scheduled(event, local, context)),
          ),
        ).then((results) => {
          if (results.some((result) => result.status === "rejected"))
            throw new Error("Scheduled dispatch unavailable");
        }),
      );
    },
  };
}
