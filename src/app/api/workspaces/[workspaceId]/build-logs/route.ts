import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { toPublicWorkspace } from "@/lib/workspaces/public-workspace";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const session = await getRequestSession();
  if (!session) return Response.json({}, { status: 401, headers });
  const { workspaceId } = await context.params;
  const query = new URL(request.url).searchParams;
  const cursor = Number(query.get("after") ?? 0);
  if (
    !z.string().uuid().safeParse(workspaceId).success ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  )
    return Response.json({}, { status: 400, headers });
  try {
    const client = await getCoderClientForUser(session.user.id, { signal: request.signal });
    const workspace = await client.getWorkspace(workspaceId);
    if (workspace.owner_id !== session.user.coderUserId)
      return Response.json({}, { status: 403, headers });
    const build = workspace.latest_build;
    const after = query.get("build") === build.id ? cursor : 0;
    const logs = await client.getWorkspaceBuildLogs(build.id, after);
    return Response.json(
      {
        workspace: toPublicWorkspace(workspace),
        logs: logs.slice(-250).map(({ id, output, stage, created_at }) => ({
          id,
          output: output.slice(0, 4096),
          stage,
          created_at,
        })),
      },
      { headers },
    );
  } catch {
    return Response.json({}, { status: 502, headers });
  }
}
