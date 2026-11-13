async function callAuth(auth, request, env, context) {
  const signal = request.signal;
  signal.throwIfAborted();
  const work = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return auth.fetch(request, env, context);
  });
  // The domain may still be finishing a database operation after its caller
  // aborts. Retain it and release any response it can no longer deliver.
  context.waitUntil(
    work.then(
      async (response) => {
        if (signal.aborted) await response.body?.cancel().catch(() => {});
      },
      () => {},
    ),
  );
  let aborted;
  try {
    const response = await Promise.race([
      work,
      new Promise((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
    if (signal.aborted) {
      context.waitUntil(Promise.resolve(response.body?.cancel()).catch(() => {}));
      signal.throwIfAborted();
    }
    if (!response.body) return response;
    // Also propagate cancellation after response headers, while a caller is
    // reading the body. The auth request lifetime observes source cancellation.
    const stream = new TransformStream();
    context.waitUntil(response.body.pipeTo(stream.writable, { signal }).catch(() => {}));
    return new Response(stream.readable, response);
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}

/** The same exact scope admits HTTP requests, alarms and scheduled repair. */
export function assertNativeEnvironment(env) {
  try {
    if (!["preview", "production"].includes(env.HIVE_NATIVE_MODE))
      throw new Error("Background deployment unavailable");
    const production = env.HIVE_NATIVE_MODE === "production";
    const database = new URL(env.DATABASE_URL);
    if (
      env.HIVE_PREVIEW_ORIGIN_ALIAS !== undefined &&
      (production ||
        env.HIVE_PUBLIC_ORIGIN !==
          "https://codex-hive-production-cutover.hive-preview.kethalia.com" ||
        env.HIVE_PREVIEW_ORIGIN_ALIAS !==
          "https://codex-hive-production-cutover-hive.b00ste.workers.dev")
    )
      throw new Error("Preview alias unavailable");
    if (
      decodeURIComponent(database.pathname.slice(1)) !== env.HIVE_DATABASE_NAME ||
      decodeURIComponent(database.username) !== env.HIVE_DATABASE_ROLE ||
      env.HIVE_DATABASE_NAME !== (production ? "hive_production" : "hive_foundation_preview") ||
      env.HIVE_DATABASE_ROLE !==
        (production ? "hive_production_runtime" : "hive_foundation_runtime") ||
      (production
        ? env.HIVE_PUBLIC_ORIGIN !== "https://hive.kethalia.com"
        : env.HIVE_PUBLIC_ORIGIN === "https://hive.kethalia.com")
    )
      throw new Error("Background deployment unavailable");
  } catch {
    throw new Error("Deployment environment unavailable");
  }
}

// Compose authentication inside the same Worker invocation and environment.
export function createNativeWorker({ app, auth }) {
  return {
    fetch(request, env, context) {
      try {
        assertNativeEnvironment(env);
      } catch {
        return new Response("deployment_pending", { status: 503 });
      }
      const url = new URL(request.url);
      if (url.origin !== env.HIVE_PUBLIC_ORIGIN) {
        if (
          env.HIVE_NATIVE_MODE === "preview" &&
          url.origin === env.HIVE_PREVIEW_ORIGIN_ALIAS &&
          ["GET", "HEAD"].includes(request.method) &&
          !request.headers.has("upgrade")
        ) {
          const target = new URL(env.HIVE_PUBLIC_ORIGIN);
          target.pathname = url.pathname;
          target.search = url.search;
          return new Response(null, {
            status: 307,
            headers: { Location: target.href, "Cache-Control": "no-store" },
          });
        }
        return new Response("Origin unavailable", { status: 403 });
      }
      const local = { ...env };
      local.AUTH_SERVICE = {
        fetch(input, init) {
          return callAuth(auth, new Request(input, init), local, context);
        },
      };
      return app.fetch(request, local, context);
    },
  };
}
