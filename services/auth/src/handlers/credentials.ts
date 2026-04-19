import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendError } from "../server.js";
import { getSessionById } from "../auth/session.js";
import { getTokenStatus } from "../auth/token-status.js";
import type { CredentialResponse } from "@hive/auth";

export async function handleGetCredentials(
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
      `[auth-service] GET /sessions/:id/credentials → 404 session=${sessionId.slice(0, 8)}…`,
    );
    sendError(res, 404, "Session not found", "NOT_FOUND");
    return;
  }

  const tokenStatus = await getTokenStatus(session.user.id);

  const payload: CredentialResponse = {
    status: tokenStatus.status,
    expiresAt: tokenStatus.expiresAt,
  };

  console.log(
    `[auth-service] GET /sessions/:id/credentials → 200 status=${tokenStatus.status}`,
  );
  sendJson(res, 200, payload);
}
