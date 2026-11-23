import { withHivePublicOrigin } from "@hive/auth/hive-origin";
import {
  appPreviewPathOrigin,
  hivePreviewDomain as previewDomain,
  hiveProductionOrigin as productionOrigin,
} from "../../../src/lib/app-preview-origin.mjs";

const previewHost = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.hive-preview\.kethalia\.com$/;
const workersPreviewHost = /^([a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?)-hive\.b00ste\.workers\.dev$/;

function previewClipboardAllowlist(policy, feature, target) {
  // The application policy already delegates to its configured Coder hosts.
  // Retain those explicit origins through the new ancestor frame.
  const origins = new Set([`"${target}"`]);
  for (const [, allowlist] of policy.matchAll(new RegExp(`\\b${feature}=\\(([^)]*)\\)`, "g"))) {
    for (const origin of allowlist.match(/"https?:\/\/[^"\s()]+"/g) ?? []) origins.add(origin);
  }
  return `${feature}=(${[...origins].join(" ")})`;
}

function framePreviewDocument(response, request, url, mode) {
  if (
    !["GET", "HEAD"].includes(request.method) ||
    request.headers.has("upgrade") ||
    !response.headers.get("Content-Type")?.startsWith("text/html")
  )
    return response;
  const policy = response.headers.get("Content-Security-Policy");
  // Keep custom or additional policies (for example a deliberately unframeable
  // response) intact. Only the normal Hive document policy is adjusted here.
  if (!policy || policy.includes(",")) return response;

  const headers = new Headers(response.headers);
  if (mode === "preview" && !/^\/(?:api|_next)(?:\/|$)/.test(url.pathname)) {
    if (!/; frame-ancestors 'self';/.test(policy)) return response;
    headers.set(
      "Content-Security-Policy",
      policy.replace("; frame-ancestors 'self';", `; frame-ancestors 'self' ${productionOrigin};`),
    );
    if (headers.get("X-Frame-Options") === "SAMEORIGIN") headers.delete("X-Frame-Options");
  } else {
    const target = appPreviewPathOrigin(url.pathname);
    if (!target) return response;
    headers.set(
      "Content-Security-Policy",
      policy.replace(/; frame-src [^;]+;/, `; frame-src ${target};`),
    );
    const existingPermissions = headers.get("Permissions-Policy") ?? "";
    headers.set(
      "Permissions-Policy",
      [
        `camera=(), geolocation=(), microphone=("${target}"), payment=(), usb=()`,
        previewClipboardAllowlist(existingPermissions, "clipboard-read", target),
        previewClipboardAllowlist(existingPermissions, "clipboard-write", target),
      ].join(", "),
    );
  }
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
      return withHivePublicOrigin(url.origin, async () =>
        framePreviewDocument(
          await app.fetch(request, local, context),
          request,
          url,
          env.HIVE_NATIVE_MODE,
        ),
      );
    },
  };
}
