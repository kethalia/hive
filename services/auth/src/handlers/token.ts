import type { IncomingMessage, ServerResponse } from "node:http";
import { ErrorCode } from "../auth/constants.js";
import { getSessionById } from "../auth/session.js";
import { getDecryptedCoderToken } from "../auth/token-status.js";
import { sendError, sendJson } from "../server.js";

export async function handleGetCoderToken(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const sessionId = params.id;

  if (!sessionId) {
    sendError(res, 400, "Missing session ID", ErrorCode.BAD_REQUEST);
    return;
  }

  const session = await getSessionById(sessionId);

  if (!session) {
    console.log(`[auth-service] GET /sessions/:id/token → 404 session=${sessionId.slice(0, 8)}…`);
    sendError(res, 404, "Session not found", ErrorCode.NOT_FOUND);
    return;
  }

  try {
    const result = await getDecryptedCoderToken(session.user.id);

    if (!result) {
      console.log(
        `[auth-service] GET /sessions/:id/token → 404 no_token user=${session.user.username}`,
      );
      sendError(res, 404, "No Coder token found", ErrorCode.TOKEN_NOT_FOUND);
      return;
    }

    console.log(`[auth-service] GET /sessions/:id/token → 200 user=${session.user.username}`);
    sendJson(res, 200, {
      token: result.token,
      coderUrl: session.user.coderUrl,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    const code =
      err instanceof Error &&
      (err.message === ErrorCode.KEY_UNAVAILABLE ||
        err.message === ErrorCode.KEY_MISMATCH ||
        err.message === ErrorCode.DECRYPT_FAILED)
        ? err.message
        : ErrorCode.INTERNAL_ERROR;

    console.error(
      `[auth-service] GET /sessions/:id/token → 500 code=${code} session=${sessionId.slice(0, 8)}…`,
    );
    sendError(res, 500, "Failed to retrieve token", code);
  }
}
