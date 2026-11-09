import {
  boundedReleaseJson,
  withReleaseDeadline,
} from "../../../deploy/cloudflare/app/release-health";
import type { ReleaseTestStore } from "./release-tested-store.server";
export async function releaseTestRoute(
  request: Request,
  operation: "challenge" | "attestation",
  store: ReleaseTestStore | null | ((body: unknown) => Promise<ReleaseTestStore | null>),
) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!store) return new Response(null, { status: 404, headers });
  if (
    request.method !== "POST" ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    return new Response(null, { status: 400, headers });
  const token = request.headers.get("x-hive-release-oidc") ?? "",
    length = request.headers.get("content-length");
  if (!/^[A-Za-z0-9_.-]{1,16384}$/.test(token)) return new Response(null, { status: 401, headers });
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768))
    return new Response(null, { status: 413, headers });
  try {
    return await withReleaseDeadline(
      async (signal) => {
        const body = await boundedReleaseJson(new Response(request.body), 32768, signal);
        const selected = typeof store === "function" ? await store(body) : store;
        if (!selected) return new Response(null, { status: 404, headers });
        return Response.json(
          operation === "challenge"
            ? await selected.challenge(body, token, signal)
            : await selected.submit(body, token, signal),
          { headers },
        );
      },
      request.signal,
      30000,
    );
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
export async function installedReleaseTestRoute(
  request: Request,
  operation: "challenge" | "attestation",
) {
  if (
    (process.env.HIVE_DELIVERY_RELEASE_ENABLED !== "true" ||
      process.env.HIVE_DELIVERY_RELEASE_TESTED_ENABLED !== "true") &&
    (process.env.HIVE_DELIVERY_EPICS_ENABLED !== "true" ||
      process.env.HIVE_DELIVERY_EPIC_MERGE_ENABLED !== "true")
  )
    return releaseTestRoute(request, operation, null);
  try {
    const [{ getDb }, { createInstalledReleaseTestStoreForRequest }] = await Promise.all([
      import("@hive/db"),
      import("./release-tested-installed.server"),
    ]);
    return releaseTestRoute(request, operation, (body) =>
      createInstalledReleaseTestStoreForRequest(getDb(), body),
    );
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
