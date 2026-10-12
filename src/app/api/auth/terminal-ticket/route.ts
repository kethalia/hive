import { createTerminalTicket } from "@hive/auth";
import { getRequestSession } from "@/lib/auth/session";
import { resolveTerminalWsUrl } from "@/lib/runtime-config";

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
    // Forwarded headers alone are not authority for minting a browser credential.
    const origin = new URL(process.env.HIVE_PUBLIC_ORIGIN || request.url).origin;
    if (request.headers.get("origin") !== origin)
      return response(403, { error: "Origin rejected" });
    const configured = process.env.NEXT_PUBLIC_TERMINAL_WS_URL || "";
    const location = new URL(origin);
    const base = httpUrl(resolveTerminalWsUrl(configured, location));
    const { url: requestedUrl } = await request.json();
    if (typeof requestedUrl !== "string" || requestedUrl.length > 3000)
      return response(400, { error: "Invalid terminal request" });
    const target = httpUrl(requestedUrl);
    const basePath = base.pathname.replace(/\/$/, "");
    const endpoint = target.pathname.slice(basePath.length);
    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(basePath) ||
      !ENDPOINTS.has(endpoint)
    )
      return response(400, { error: "Invalid terminal request" });
    if (process.env.NODE_ENV === "production" && base.protocol !== "https:")
      return response(503, { error: "Terminal requires HTTPS" });
    const session = await getRequestSession();
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
