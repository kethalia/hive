import { withHivePublicOrigin } from "@hive/auth/hive-origin";

const productionOrigin = "https://hive.kethalia.com";
const previewDomain = "hive-preview.kethalia.com";
const previewHost = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.hive-preview\.kethalia\.com$/;
const workersPreviewHost = /^([a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?)-hive\.b00ste\.workers\.dev$/;

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
    const databaseName = production ? "hive_production" : "hive_workspace_accounts_preview";
    const databaseRole = production ? "hive_production_runtime" : "hive_accounts_runtime";
    const origin = production ? productionOrigin : `https://${previewDomain}`;
    if (
      env.HIVE_PUBLIC_ORIGIN !== origin ||
      env.HIVE_DATABASE_NAME !== databaseName ||
      env.HIVE_DATABASE_ROLE !== databaseRole ||
      decodeURIComponent(database.pathname.slice(1)) !== databaseName ||
      decodeURIComponent(database.username) !== databaseRole
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
      if (env.HIVE_NATIVE_MODE === "preview") {
        const alias =
          url.protocol === "https:" && !url.port && workersPreviewHost.exec(url.hostname);
        if (alias && ["GET", "HEAD"].includes(request.method) && !request.headers.has("upgrade")) {
          url.hostname = `${alias[1]}.${previewDomain}`;
          return new Response(null, {
            status: 307,
            headers: { Location: url.href, "Cache-Control": "no-store" },
          });
        }
        if (url.protocol !== "https:" || url.port || !previewHost.test(url.hostname))
          return new Response("Origin unavailable", { status: 403 });
      } else if (url.origin !== productionOrigin) {
        return new Response("Origin unavailable", { status: 403 });
      }
      const local = { ...env, HIVE_PUBLIC_ORIGIN: url.origin };
      local.AUTH_SERVICE = {
        fetch(input, init) {
          return callAuth(auth, new Request(input, init), local, context);
        },
      };
      return withHivePublicOrigin(url.origin, () => app.fetch(request, local, context));
    },
  };
}
