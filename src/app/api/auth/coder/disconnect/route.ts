import { type CoderDisconnectRequest, getCoderOAuthConfig } from "@hive/auth";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { getRequestSession } from "@/lib/auth/session";
import { coderDisconnectRequestSchema } from "@/lib/settings/window-contracts";
import { publicationBody } from "@/lib/templates/publication-io";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const error = (code: string, status: number) => Response.json({ error: code }, { status, headers });

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (request.method !== "POST") return error("invalid_method", 405);
  if (
    request.headers.get("origin") !== url.origin ||
    (request.headers.has("sec-fetch-site") &&
      request.headers.get("sec-fetch-site") !== "same-origin")
  )
    return error("invalid_origin", 403);
  if (
    url.search ||
    request.headers.has("content-encoding") ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    return error("invalid_request", 400);
  let input: CoderDisconnectRequest;
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    input = coderDisconnectRequestSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await publicationBody(
            new Response(request.body, { headers: request.headers }),
            512,
            signal,
          ),
        ),
      ),
    );
    signal.throwIfAborted();
  } catch {
    return error("invalid_request", 400);
  }
  try {
    const config = getCoderOAuthConfig();
    if (!config || config.publicOrigin !== url.origin) return error("disconnect_unavailable", 503);
    const session = await getRequestSession();
    if (!session) return error("not_authenticated", 401);
    const result = await getAuthServiceClient().disconnectCoderOAuth(
      session.session.sessionId,
      input,
      request.signal,
    );
    // The captured session is gone. Do not clear cookies or redirect: a newer
    // concurrent sign-in may already have replaced this browser's cookie.
    return Response.json(result, { headers });
  } catch (failure) {
    const code = failure instanceof Error ? failure.message : "";
    return code === "coder_disconnect_unauthorized"
      ? error("not_authenticated", 401)
      : [
            "coder_disconnect_changed",
            "coder_disconnect_busy",
            "coder_disconnect_unsupported",
          ].includes(code)
        ? error("connection_changed", 409)
        : error("disconnect_unknown", 503);
  }
}
