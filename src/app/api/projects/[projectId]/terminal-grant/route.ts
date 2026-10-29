import {
  authorizeSessionOwner,
  sessionError,
  sessionResponseHeaders,
  sessionService,
} from "@/lib/codex-session/route.server";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await authorizeSessionOwner(request);
    if (session instanceof Response) return session;
    const { projectId } = await params;
    return Response.json(
      await sessionService().terminalGrant(
        { hiveUserId: session.user.id, coderUserId: session.user.coderUserId },
        projectId,
      ),
      { headers: sessionResponseHeaders },
    );
  } catch {
    return sessionError("session_unavailable", 403);
  }
}
