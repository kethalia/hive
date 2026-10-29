import {
  boundedSessionJson,
  sessionError,
  sessionResponseHeaders,
  sessionService,
} from "@/lib/codex-session/route.server";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ registrationId: string }> },
) {
  if (process.env.HIVE_CODEX_GATEWAY_ENABLED !== "true")
    return sessionError("session_disabled", 404);
  try {
    const input = await boundedSessionJson(request, 4096),
      { registrationId } = await params;
    if (input?.registrationId !== registrationId) return sessionError("registration_rejected", 403);
    return Response.json(await sessionService().heartbeat(input), {
      headers: sessionResponseHeaders,
    });
  } catch {
    return sessionError("registration_rejected", 403);
  }
}
