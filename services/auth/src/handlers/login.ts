import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBody, sendJson, sendError } from "../server.js";
import { performLogin } from "../auth/login.js";
import { loginRateLimiter } from "../auth/rate-limit.js";
import { ErrorCode } from "../auth/constants.js";

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await parseBody(req)) as Record<string, unknown> | undefined;

  if (!body || typeof body !== "object") {
    sendError(res, 400, "Request body is required", ErrorCode.BAD_REQUEST);
    return;
  }

  const { coderUrl, email, password } = body as {
    coderUrl?: string;
    email?: string;
    password?: string;
  };

  if (!coderUrl || !email || !password) {
    const missing = [
      !coderUrl && "coderUrl",
      !email && "email",
      !password && "password",
    ].filter(Boolean);
    sendError(
      res,
      400,
      `Missing required fields: ${missing.join(", ")}`,
      ErrorCode.BAD_REQUEST,
    );
    return;
  }

  const ip = getClientIp(req);
  const rateCheck = loginRateLimiter.check(ip);
  if (!rateCheck.allowed) {
    console.log(`[auth-service] Rate limited login attempt from ${ip}`);
    sendJson(res, 429, {
      error: "Too many login attempts",
      code: ErrorCode.RATE_LIMITED,
      retryAfterMs: rateCheck.resetMs,
    });
    return;
  }

  try {
    const result = await performLogin(coderUrl, email, password);
    console.log(`[auth-service] POST /login → 200 user=${result.user.id}`);
    sendJson(res, 200, {
      sessionId: result.sessionId,
      user: result.user,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const messageLower = message.toLowerCase();

    if (messageLower.includes("invalid coder instance") || messageLower.includes("unreachable")) {
      console.log(`[auth-service] POST /login → 502 coder unreachable`);
      sendError(res, 502, "Coder instance unreachable", ErrorCode.CODER_UNREACHABLE);
      return;
    }

    if (
      messageLower.includes("invalid credentials") ||
      messageLower.includes("authentication failed") ||
      messageLower.includes("401")
    ) {
      console.log(`[auth-service] POST /login → 401 invalid credentials`);
      sendError(res, 401, "Invalid credentials", ErrorCode.INVALID_CREDENTIALS);
      return;
    }

    console.error(`[auth-service] POST /login → 500 ${message}`);
    sendError(res, 500, "Internal server error", ErrorCode.INTERNAL_ERROR);
  }
}
