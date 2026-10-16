import { createHash, randomBytes } from "node:crypto";
import { getDb } from "@hive/db";
import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { installNotificationHooks } from "@/lib/push/install";

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
  const token = randomBytes(32).toString("hex");
  try {
    const workspaceName = await installNotificationHooks(
      session.user.id,
      workspaceId,
      `${origin}/api/notifications/events`,
      token,
    );
    await getDb().notificationSource.upsert({
      where: { userId_workspaceId: { userId: session.user.id, workspaceId } },
      create: {
        userId: session.user.id,
        workspaceId,
        workspaceName,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
      update: { workspaceName, tokenHash: createHash("sha256").update(token).digest("hex") },
    });
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
