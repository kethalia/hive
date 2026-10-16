import { getDb } from "@hive/db";
import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { installNotificationHooks, prepareNotificationWorkspace } from "@/lib/push/install";

import {
  confirmNotificationCredential,
  stageNotificationCredential,
} from "@/lib/push/source-credentials";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const origin = new URL(process.env.HIVE_PUBLIC_ORIGIN || request.url).origin;
  if (request.headers.get("origin") !== origin) return new Response(null, { status: 403 });
  const session = await getRequestSession();
  if (!session) return new Response(null, { status: 401 });
  const parsed = z
    .object({ workspaceId: z.string().uuid() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400 });
  const { workspaceId } = parsed.data;
  try {
    const prepared = await prepareNotificationWorkspace(session.user.id, workspaceId);
    const { source, token } = await stageNotificationCredential(
      session.user.id,
      workspaceId,
      prepared.workspaceName,
    );
    await installNotificationHooks(prepared, `${origin}/api/notifications/events`, token, {
      sourceId: source.id,
      generation: source.credentialGeneration,
      createdAt: source.createdAt.toISOString(),
    });
    await confirmNotificationCredential(
      source.id,
      source.credentialGeneration,
      token,
      prepared.workspaceName,
    );
    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Workspace setup failed" },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request) {
  const origin = new URL(process.env.HIVE_PUBLIC_ORIGIN || request.url).origin;
  if (request.headers.get("origin") !== origin) return new Response(null, { status: 403 });
  const session = await getRequestSession();
  if (!session) return new Response(null, { status: 401 });
  const input = z
    .object({ workspaceId: z.string().uuid() })
    .safeParse(await request.json().catch(() => null));
  if (!input.success) return new Response(null, { status: 400 });
  await getDb().notificationSource.deleteMany({
    where: { userId: session.user.id, workspaceId: input.data.workspaceId },
  });
  return Response.json({ success: true });
}
