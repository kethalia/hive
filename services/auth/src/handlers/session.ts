import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendError } from "../server.js";
import { getSessionById } from "../auth/session.js";
import type { SessionPayload } from "@hive/auth";

export async function handleGetSession(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const sessionId = params.id;

  if (!sessionId) {
    sendError(res, 400, "Missing session ID", "BAD_REQUEST");
    return;
  }

  const session = await getSessionById(sessionId);

  if (!session) {
    console.log(
      `[auth-service] GET /sessions/:id → 404 session=${sessionId.slice(0, 8)}…`,
    );
    sendError(res, 404, "Session not found", "NOT_FOUND");
    return;
  }

  const payload: SessionPayload = {
    userId: session.user.id,
    username: session.user.username,
    email: session.user.email,
    coderUrl: session.user.coderUrl,
    sessionId: session.session.sessionId,
    expiresAt: session.session.expiresAt.toISOString(),
  };

  console.log(
    `[auth-service] GET /sessions/:id → 200 user=${session.user.id}`,
  );
  sendJson(res, 200, payload);
}
