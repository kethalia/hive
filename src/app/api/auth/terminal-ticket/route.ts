import { createTerminalTicket, isLoopbackHostname } from "@hive/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getRequestSession } from "@/lib/auth/session";
import { resolveTerminalWsUrl, serverTerminalWsUrl } from "@/lib/runtime-config";
import { publicationBody } from "@/lib/templates/publication-io";
import { TERMINAL_AUTH_SERVER_TIMEOUT_MS } from "@/lib/terminal/auth-deadlines";
import {
  type GenericTerminalAuthEnvironment,
  genericTerminalIssuerSession,
} from "@/lib/terminal/generic-auth.server";
import { parseGenericTerminalTarget } from "../../../../../deploy/cloudflare/app/generic-terminal-relay";

const ENDPOINTS = new Set(["/ws", "/ws/audio", "/keepalive/status", "/session-events"]);

function httpUrl(value: string): URL {
  const url = new URL(value.replace(/^ws(s?):/, "http$1:"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("Invalid terminal URL.");
  return url;
}

export async function POST(request: Request): Promise<Response> {
  const response = (status: number, data: unknown) =>
    Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  try {
    const cloudflare = process.env.HIVE_RUNTIME_TARGET === "cloudflare";
    if (cloudflare && process.env.HIVE_GENERIC_TERMINAL_ENABLED !== "true")
      return response(404, { error: "Terminal transport unavailable" });
    // Forwarded headers alone are not authority for minting a browser credential.
    const origin = new URL(process.env.HIVE_PUBLIC_ORIGIN || request.url).origin;
    if (request.headers.get("origin") !== origin)
      return response(403, { error: "Origin rejected" });
    const configured = serverTerminalWsUrl();
    const location = new URL(origin);
    const base = httpUrl(resolveTerminalWsUrl(configured, location));
    if (
      request.headers.get("Content-Type")?.split(";")[0] !== "application/json" ||
      request.headers.has("Content-Encoding")
    )
      return response(400, { error: "Invalid terminal request" });
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(TERMINAL_AUTH_SERVER_TIMEOUT_MS),
    ]);
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await publicationBody(
          new Response(request.body, { headers: request.headers }),
          4096,
          signal,
        ),
      ),
    );
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1)
      return response(400, { error: "Invalid terminal request" });
    const { url: requestedUrl } = body;
    if (typeof requestedUrl !== "string" || requestedUrl.length > 3000)
      return response(400, { error: "Invalid terminal request" });
    const target = httpUrl(requestedUrl);
    if (cloudflare && (target.origin !== origin || !parseGenericTerminalTarget(target)))
      return response(400, { error: "Invalid terminal request" });
    const basePath = base.pathname.replace(/\/$/, "");
    const endpoint = target.pathname.slice(basePath.length);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(basePath) ||
      !ENDPOINTS.has(endpoint)
    )
      return response(400, { error: "Invalid terminal request" });
    const localLoopback =
      isLoopbackHostname(location.hostname) && isLoopbackHostname(base.hostname);
    if (process.env.NODE_ENV === "production" && base.protocol !== "https:" && !localLoopback)
      return response(503, { error: "Terminal requires HTTPS" });
    const session = cloudflare
      ? await genericTerminalIssuerSession(
          request,
          getCloudflareContext().env as GenericTerminalAuthEnvironment,
        )
      : await getRequestSession();
    signal.throwIfAborted();
    if (!session) return response(401, { error: "Sign in required" });
    const ticket = createTerminalTicket(
      {
        sessionId: session.session.sessionId,
        audience: target.host,
        origin,
        requestTarget: `${endpoint}${target.search}`,
      },
      process.env.COOKIE_SECRET || "",
      session.session.expiresAt.getTime(),
    );
    return response(200, { ticket });
  } catch {
    return response(400, { error: "Terminal authorization unavailable" });
  }
}
