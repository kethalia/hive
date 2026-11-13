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
          return callAuth(auth, new Request(input, init), local, context);
        },
      };
      return app.fetch(request, local, context);
    },
  };
}
