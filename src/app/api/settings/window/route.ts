import { getRequestSession } from "@/lib/auth/session";
import { readSettingsWindow } from "@/lib/settings/window.server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const error = (code: string, status: number) => Response.json({ error: code }, { status, headers });

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
  )
    return error("invalid_origin", 403);
  try {
    const session = await getRequestSession();
    if (!session) return error("not_authenticated", 401);
    if (url.search) return error("invalid_request", 400);
    const result = await readSettingsWindow(session.user, request.signal);
    return Response.json(result, { headers });
  } catch {
    return error("settings_unavailable", 503);
  }
}
