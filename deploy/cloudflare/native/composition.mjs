// Compose authentication inside the same Worker invocation and environment.
export function createNativeWorker({ app, auth }) {
  return {
    fetch(request, env, context) {
      if (env.HIVE_NATIVE_MODE !== "preview")
        return new Response("deployment_pending", { status: 503 });
      // A new Preview may inherit Base secrets. Admit this foundation only with
      // its enrolled database and restricted runtime role.
      try {
        const database = new URL(env.DATABASE_URL);
        if (
          decodeURIComponent(database.pathname.slice(1)) !== env.HIVE_DATABASE_NAME ||
          decodeURIComponent(database.username) !== env.HIVE_DATABASE_ROLE ||
          env.HIVE_DATABASE_NAME !== "hive_foundation_preview" ||
          env.HIVE_DATABASE_ROLE !== "hive_foundation_runtime"
        )
          throw new Error();
      } catch {
        return new Response("deployment_pending", { status: 503 });
      }
      if (new URL(request.url).origin !== env.HIVE_PUBLIC_ORIGIN)
        return new Response("Origin unavailable", { status: 403 });
      const local = { ...env };
      local.AUTH_SERVICE = {
        fetch(input, init) {
          return auth.fetch(new Request(input, init), local, context);
        },
      };
      return app.fetch(request, local, context);
    },
  };
}
