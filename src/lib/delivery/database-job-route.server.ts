import {
  boundedReleaseJson,
  withReleaseDeadline,
} from "../../../deploy/cloudflare/app/release-health";
import type { DatabaseJobStore } from "./database-job-store.server";

/** OIDC is verified against the complete request by the store. */
export async function databaseJobRoute(
  request: Request,
  operation: "approve" | "job",
  store: DatabaseJobStore | null,
  postResponse?: (work: () => Promise<void>) => void,
) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!store) return new Response(null, { status: 404, headers });
  const url = new URL(request.url);
  const path = operation === "approve" ? "approve" : "authorize";
  if (
    request.headers.has("origin") ||
    url.search ||
    url.hash ||
    url.pathname !== `/api/delivery/database-jobs/${path}`
  )
    return new Response(null, { status: 400, headers });
  if (
    request.method !== "POST" ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    return new Response(null, { status: 400, headers });
  const token = request.headers.get("x-hive-database-oidc") ?? "";
  if (!/^[A-Za-z0-9_.-]{1,16384}$/.test(token)) return new Response(null, { status: 401, headers });
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 49152))
    return new Response(null, { status: 413, headers });
  try {
    return await withReleaseDeadline(
      async (signal) => {
        const body = await boundedReleaseJson(new Response(request.body), 49152, signal);
        const result =
          operation === "approve"
            ? await store.approve(body, token, signal)
            : await store.job(body, token, signal);
        const followup = postResponse ? store.postResponse?.(body, result) : null;
        if (followup) postResponse?.(followup);
        return Response.json(result, { headers });
      },
      request.signal,
      store.requestBudgetMs ?? 15000,
    );
  } catch {
    return new Response(null, { status: 503, headers });
  }
}

export async function installedDatabaseJobRoute(request: Request, operation: "approve" | "job") {
  if (process.env.HIVE_DELIVERY_DATABASE_ENABLED !== "true")
    return databaseJobRoute(request, operation, null);
  try {
    const [{ getDb }, { createInstalledDatabaseJobStore }] = await Promise.all([
      import("@hive/db"),
      import("./database-job-installed.server"),
    ]);
    const { after } = await import("next/server");
    return databaseJobRoute(request, operation, createInstalledDatabaseJobStore(getDb()), (work) =>
      after(work),
    );
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
