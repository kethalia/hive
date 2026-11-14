import { getDb } from "@hive/db";
import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { terminalBody } from "@/lib/terminal/transport-io";
import { installNotificationHooks, prepareNotificationWorkspace } from "./install";
import {
  callbackTokenHash,
  confirmNotificationCredential,
  stageNotificationCredential,
} from "./source-credentials";

const headers = { "Cache-Control": "private, no-store" };
export async function cloudflareNotificationSourcesRoute(request: Request) {
  const url = new URL(request.url);
  if (
    url.origin !== process.env.HIVE_PUBLIC_ORIGIN ||
    request.headers.get("Origin") !== url.origin ||
    request.url.includes("?") ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return new Response(null, { status: 403, headers });
  const session = await getRequestSession();
  if (!session) return new Response(null, { status: 401, headers });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
  let workspaceId: string;
  try {
    const bytes = await terminalBody(
      new Response(request.body),
      1024,
      AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    );
    workspaceId = z
      .object({ workspaceId: z.string().uuid() })
      .strict()
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).workspaceId;
  } catch {
    return new Response(null, { status: 400, headers });
  }
  let staged = false;
  try {
    signal.throwIfAborted();
    if (request.method === "DELETE") {
      await getDb().notificationSource.deleteMany({
        where: { userId: session.user.id, workspaceId },
      });
      return Response.json({ success: true }, { headers });
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers });
    const prepared = await prepareNotificationWorkspace(session.user.id, workspaceId, signal);
    signal.throwIfAborted();
    const { source, token } = await stageNotificationCredential(
      session.user.id,
      workspaceId,
      prepared.workspaceName,
    );
    staged = true;
    signal.throwIfAborted();
    await installNotificationHooks(
      prepared,
      `${url.origin}/api/notifications/events`,
      token,
      {
        sourceId: source.id,
        generation: source.credentialGeneration,
        createdAt: source.createdAt.toISOString(),
      },
      signal,
    );
    signal.throwIfAborted();
    const confirmed = await confirmNotificationCredential(
      source.id,
      source.credentialGeneration,
      token,
      prepared.workspaceName,
      signal,
    );
    signal.throwIfAborted();
    if (!confirmed) {
      const current = await getDb().notificationSource.findFirst({
        where: {
          id: source.id,
          userId: session.user.id,
          workspaceId,
          credentialGeneration: source.credentialGeneration,
          tokenHash: callbackTokenHash(token),
          pendingTokenHash: null,
        },
      });
      if (!current) throw Error("setup_outcome_unknown");
    }
    signal.throwIfAborted();
    return Response.json({ success: true }, { headers });
  } catch {
    return Response.json(
      { error: staged ? "setup_outcome_unknown" : "sources_unavailable" },
      {
        status: staged ? 409 : 503,
        headers,
      },
    );
  }
}
