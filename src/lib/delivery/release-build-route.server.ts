import {
  boundedReleaseJson,
  withReleaseDeadline,
} from "../../../deploy/cloudflare/app/release-health";
import type { ReleaseBuildStore } from "./release-build-store.server";

/** Internal endpoint adapter. Authentication is the exact GitHub OIDC audience
 * verified by the store, followed by its transaction-scoped authority check.
 * Installation requires a fully configured controller, so absent capability
 * yields 404 and does not contact GitHub or the database. */
export async function releaseBuildRoute(
  request: Request,
  operation: "challenge" | "attestation",
  store: ReleaseBuildStore | null,
) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!store) return new Response(null, { status: 404, headers });
  if (
    request.method !== "POST" ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    return new Response(null, { status: 400, headers });
  const authorization = request.headers.get("x-hive-release-oidc") ?? "";
  const match = /^([A-Za-z0-9_.-]{1,16384})$/.exec(authorization);
  if (!match) return new Response(null, { status: 401, headers });
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768))
    return new Response(null, { status: 413, headers });
  try {
    return await withReleaseDeadline(
      async (signal) => {
        const body = await boundedReleaseJson(new Response(request.body), 32768, signal);
        const result =
          operation === "challenge"
            ? await store.challenge(body, match[1], signal)
            : await store.submit(body, match[1], signal);
        return Response.json(result, { headers });
      },
      request.signal,
      15000,
    );
  } catch {
    return new Response(null, { status: 503, headers });
  }
}

/** Runtime entry used by the fixed internal routes. Disabled means no DB or
 * credential lookup; malformed enabled configuration is unavailable. */
export async function installedReleaseBuildRoute(
  request: Request,
  operation: "challenge" | "attestation",
) {
  if (process.env.HIVE_DELIVERY_RELEASE_ENABLED !== "true")
    return releaseBuildRoute(request, operation, null);
  try {
    const [{ getDb }, { createInstalledReleaseController }] = await Promise.all([
      import("@hive/db"),
      import("./release-installed.server"),
    ]);
    const controller = createInstalledReleaseController(getDb());
    return releaseBuildRoute(
      request,
      operation,
      controller?.kind === "native-preview" ? null : (controller?.builds ?? null),
    );
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
