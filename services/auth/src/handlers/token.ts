import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendError } from "../server.js";
import { getSessionById } from "../auth/session.js";
import { getDecryptedCoderToken } from "../auth/token-status.js";

export async function handleGetCoderToken(
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
      `[auth-service] GET /sessions/:id/token → 404 session=${sessionId.slice(0, 8)}…`,
    );
    sendError(res, 404, "Session not found", "NOT_FOUND");
    return;
  }

  try {
    const result = await getDecryptedCoderToken(session.user.id);

    if (!result) {
      console.log(
        `[auth-service] GET /sessions/:id/token → 404 no_token user=${session.user.username}`,
      );
      sendError(res, 404, "No Coder token found", "TOKEN_NOT_FOUND");
      return;
    }

    console.log(
      `[auth-service] GET /sessions/:id/token → 200 user=${session.user.username}`,
    );
    sendJson(res, 200, {
      token: result.token,
      coderUrl: session.user.coderUrl,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    const code =
      err instanceof Error &&
      (err.message === "KEY_UNAVAILABLE" ||
        err.message === "KEY_MISMATCH" ||
        err.message === "DECRYPT_FAILED")
        ? err.message
        : "INTERNAL_ERROR";

    console.error(
      `[auth-service] GET /sessions/:id/token → 500 code=${code} session=${sessionId.slice(0, 8)}…`,
    );
    sendError(res, 500, "Failed to retrieve token", code);
  }
}
