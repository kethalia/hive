import { timingSafeEqual } from "node:crypto";
import { authServiceHeaders, type SessionPayload } from "@hive/auth";
import { ErrorCode } from "./auth/constants.js";
import * as domain from "./auth/domain.js";
import { loginRateLimiter } from "./auth/rate-limit.js";

const MAX_BODY_BYTES = 1024 * 1024;
type Operations = Pick<
  typeof domain,
  "performLogin" | "deleteSession" | "getSessionById" | "getTokenStatus" | "getDecryptedCoderToken"
>;

class BodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function error(status: number, message: string, code: string): Response {
  return json({ error: message, code }, status);
}

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BodyError("Request body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return undefined;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BodyError("Invalid JSON body", 400);
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** Fetch transport around the existing auth domain, with no origin service fallback. */
export function createFetchAuthHandler(
  secret: string | undefined,
  operations: Operations = domain,
  limiter = loginRateLimiter,
): (request: Request) => Promise<Response> {
  const expected = Buffer.from(authServiceHeaders(secret).Authorization);
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === "/health") return json({ status: "ok" });
    const authorization = Buffer.from(request.headers.get("authorization") ?? "");
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      return error(401, "Service authentication required", "SERVICE_UNAUTHORIZED");
    }
    try {
      if (request.method === "POST" && pathname === "/login") {
        const input = await body(request);
        if (!input) return error(400, "Request body is required", ErrorCode.BAD_REQUEST);
        if ("coderUrl" in input)
          return error(400, "Coder origin is configured by the server", ErrorCode.BAD_REQUEST);
        const { email, password } = input;
        if (typeof email !== "string" || !email || typeof password !== "string" || !password)
          return error(400, "Valid email and password are required", ErrorCode.BAD_REQUEST);
        // This header is accepted only after service authentication. Browser
        // supplied forwarding headers are never read by this transport.
        const rate = limiter.check(request.headers.get("X-Hive-Client-IP") ?? "service-binding");
        if (!rate.allowed)
          return json(
            {
              error: "Too many login attempts",
              code: ErrorCode.RATE_LIMITED,
              retryAfterMs: rate.resetMs,
            },
            429,
          );
        try {
          return json(await operations.performLogin(email, password));
        } catch (failure) {
          const message = failure instanceof Error ? failure.message.toLowerCase() : "";
          if (message.includes("invalid coder instance") || message.includes("unreachable"))
            return error(502, "Coder instance unreachable", ErrorCode.CODER_UNREACHABLE);
          if (
            message.includes("invalid credentials") ||
            message.includes("authentication failed") ||
            message.includes("401")
          )
            return error(401, "Invalid credentials", ErrorCode.INVALID_CREDENTIALS);
          return error(500, "Internal server error", ErrorCode.INTERNAL_ERROR);
        }
      }
      if (request.method === "POST" && pathname === "/logout") {
        const input = await body(request);
        if (!input || typeof input.sessionId !== "string" || !input.sessionId)
          return error(
            400,
            "Missing or invalid field: sessionId must be a string",
            ErrorCode.BAD_REQUEST,
          );
        await operations.deleteSession(input.sessionId);
        return json({ ok: true });
      }
      const match = /^\/sessions\/([^/]+)(?:\/(credentials|token))?$/.exec(pathname);
      if (request.method !== "GET" || !match) return error(404, "Not found", ErrorCode.NOT_FOUND);
      const session = await operations.getSessionById(match[1]);
      if (!session) return error(404, "Session not found", ErrorCode.NOT_FOUND);
      if (match[2] === "credentials") {
        const status = await operations.getTokenStatus(session.user.id);
        return json({ status: status.status, expiresAt: status.expiresAt?.toISOString() ?? null });
      }
      if (match[2] === "token") {
        try {
          const token = await operations.getDecryptedCoderToken(session.user.id);
          if (!token) return error(404, "No Coder token found", ErrorCode.TOKEN_NOT_FOUND);
          return json({
            token: token.token,
            coderUrl: session.user.coderUrl,
            expiresAt: token.expiresAt?.toISOString() ?? null,
          });
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : "";
          const code = [
            ErrorCode.KEY_UNAVAILABLE,
            ErrorCode.KEY_MISMATCH,
            ErrorCode.DECRYPT_FAILED,
          ].find((allowed) => allowed === message);
          return error(500, "Failed to retrieve token", code ?? ErrorCode.INTERNAL_ERROR);
        }
      }
      const payload: SessionPayload = {
        userId: session.user.id,
        coderUserId: session.user.coderUserId,
        username: session.user.username,
        email: session.user.email,
        coderUrl: session.user.coderUrl,
        sessionId: session.session.sessionId,
        expiresAt: session.session.expiresAt.toISOString(),
      };
      return json(payload);
    } catch (failure) {
      if (failure instanceof BodyError)
        return error(failure.status, failure.message, ErrorCode.BAD_REQUEST);
      return error(500, "Internal server error", ErrorCode.INTERNAL_ERROR);
    }
  };
}
