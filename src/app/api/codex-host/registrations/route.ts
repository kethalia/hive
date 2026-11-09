import {
  boundedSessionJson,
  sessionError,
  sessionResponseHeaders,
  sessionService,
} from "@/lib/codex-session/route.server";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (process.env.HIVE_CODEX_GATEWAY_ENABLED !== "true")
    return sessionError("session_disabled", 404);
  try {
    return Response.json(await sessionService().redeem(await boundedSessionJson(request)), {
      headers: sessionResponseHeaders,
    });
  } catch {
    return sessionError("registration_rejected", 403);
  }
}
