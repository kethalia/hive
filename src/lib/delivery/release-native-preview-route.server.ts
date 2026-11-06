import {
  boundedReleaseJson,
  withReleaseDeadline,
} from "../../../deploy/cloudflare/app/release-health";
import type { createNativePreviewReleaseController } from "./release-native-preview-controller.server";

type Controller = NonNullable<ReturnType<typeof createNativePreviewReleaseController>>;
/** Fixed machine ingress only. No public owner cookie, provider credential,
 * target, origin or endpoint choice grants authority. Every body has a distinct
 * publisher OIDC audience and store reauthorization. */
export async function nativeReleaseRoute(
  request: Request,
  operation: "artifact" | "grant" | "reauthorize" | "receipt",
  controller: Controller | null,
) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!controller) return new Response(null, { status: 404, headers });
  const url = new URL(request.url),
    token = request.headers.get("x-hive-release-oidc") ?? "",
    length = request.headers.get("content-length");
  if (
    request.method !== "POST" ||
    url.pathname !== `/api/internal/native-release/${operation}` ||
    url.search ||
    request.headers.has("origin") ||
    request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" ||
    !/^[A-Za-z0-9_.-]{1,16384}$/.test(token)
  )
    return new Response(null, { status: 400, headers });
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768))
    return new Response(null, { status: 413, headers });
  try {
    return await withReleaseDeadline(
      async (signal) => {
        const body = await boundedReleaseJson(new Response(request.body), 32768, signal);
        const result =
          operation === "artifact"
            ? await controller.stageArtifact(body, token, signal)
            : operation === "grant"
              ? await controller.publications.grant(body, token, signal)
              : operation === "reauthorize"
                ? await controller.publications.reauthorize(body, token, signal)
                : await controller.publications.receipt(body, token, signal);
        return Response.json(result, { headers });
      },
      request.signal,
      30000,
    );
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
export async function installedNativeReleaseRoute(
  request: Request,
  operation: "artifact" | "grant" | "reauthorize" | "receipt",
) {
  if (process.env.HIVE_DELIVERY_RELEASE_ENABLED !== "true")
    return nativeReleaseRoute(request, operation, null);
  try {
    const [{ getDb }, { createInstalledReleaseController }] = await Promise.all([
      import("@hive/db"),
      import("./release-installed.server"),
    ]);
    const controller = createInstalledReleaseController(getDb());
    return nativeReleaseRoute(
      request,
      operation,
      controller?.kind === "native-preview" ? controller : null,
    );
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
