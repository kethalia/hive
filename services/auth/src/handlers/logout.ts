import type { IncomingMessage, ServerResponse } from "node:http";
import { ErrorCode } from "../auth/constants.js";
import { deleteSession } from "../auth/session.js";
import { parseBody, sendError, sendJson } from "../server.js";

export async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await parseBody(req)) as Record<string, unknown> | undefined;

  if (!body || typeof body !== "object" || !body.sessionId || typeof body.sessionId !== "string") {
    sendError(
      res,
      400,
      "Missing or invalid field: sessionId must be a string",
      ErrorCode.BAD_REQUEST,
    );
    return;
  }

  const { sessionId } = body as { sessionId: string };

  await deleteSession(sessionId);
  console.log(`[auth-service] POST /logout → 200 session=${sessionId.slice(0, 8)}…`);
  sendJson(res, 200, { ok: true });
}
