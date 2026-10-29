import type { IncomingMessage } from "node:http";
import type { CoderTokenResponse } from "@hive/auth";
import {
  authServiceHeaders,
  getConfiguredCoderUrl,
  isConfiguredCoderUrl,
  isLoopbackHostname,
  sessionCookieValues,
  verifyCookie,
  verifyTerminalTicket,
} from "@hive/auth";

const AUTH_SERVICE_TIMEOUT_MS = 5_000;

export interface AuthSuccess {
  token: string;
  coderUrl: string;
  sessionId: string;
  username: string;
}

export interface AuthFailure {
  error: string;
  status: number;
  reason: string;
}

export type AuthResult = { ok: true; value: AuthSuccess } | { ok: false; value: AuthFailure };

export async function authenticateUpgrade(req: IncomingMessage): Promise<AuthResult> {
  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[terminal-proxy] auth: COOKIE_SECRET not configured → 502");
    return {
      ok: false,
      value: { error: "Server misconfigured", status: 502, reason: "cookie_secret_missing" },
    };
  }

  const values = sessionCookieValues(req.headers.cookie);
  if (values.length > 1)
    return {
      ok: false,
      value: { error: "Ambiguous session cookie", status: 401, reason: "ambiguous_cookie" },
    };
  const protocols = (req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim());
  const tickets = protocols
    .filter((value) => value.startsWith("hive-ticket."))
    .map((value) => value.slice("hive-ticket.".length));
  if (req.headers.authorization) {
    tickets.push(
      req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "",
    );
  }
  let sessionId: string;
  if (tickets.length) {
    let claims: ReturnType<typeof verifyTerminalTicket> = null;
    try {
      let authority = new URL(
        process.env.TERMINAL_PUBLIC_ORIGIN ||
          `${process.env.NODE_ENV === "production" ? "https" : "http"}://${req.headers.host}`,
      );
      if (
        !process.env.TERMINAL_PUBLIC_ORIGIN &&
        process.env.NODE_ENV === "production" &&
        isLoopbackHostname(authority.hostname)
      )
        authority = new URL(`http://${req.headers.host}`);
      if (tickets.length === 1)
        claims = verifyTerminalTicket(tickets[0], cookieSecret, {
          audience: authority.host,
          // Same-origin GETs may omit Origin. Only the proxy's own public
          // origin may use that case; cross-origin tickets must supply Origin.
          origin: req.headers.origin || authority.origin,
          requestTarget: req.url || "/",
        });
    } catch {
      /* Invalid public authority fails closed. */
    }
    if (!claims)
      return {
        ok: false,
        value: { error: "Invalid terminal ticket", status: 401, reason: "invalid_terminal_ticket" },
      };
    sessionId = claims.sessionId;
  } else {
    if (values.length !== 1 || !values[0])
      return {
        ok: false,
        value: {
          error: "Missing or ambiguous session cookie",
          status: 401,
          reason: values.length > 1 ? "ambiguous_cookie" : "no_cookie",
        },
      };
    const verified = verifyCookie(values[0], cookieSecret);
    if (!verified)
      return {
        ok: false,
        value: { error: "Invalid cookie signature", status: 401, reason: "invalid_hmac" },
      };
    sessionId = verified.sessionId;
  }
  const truncatedId = sessionId.slice(0, 8);

  const authServiceUrl = (process.env.AUTH_SERVICE_URL || "http://localhost:4400").replace(
    /\/+$/,
    "",
  );

  let serviceHeaders: ReturnType<typeof authServiceHeaders>;
  try {
    serviceHeaders = authServiceHeaders();
  } catch {
    console.error("[terminal-proxy] auth: auth_service_secret_invalid → 502");
    return {
      ok: false,
      value: { error: "Server misconfigured", status: 502, reason: "auth_service_secret_invalid" },
    };
  }

  let tokenRes: Response;
  let sessionRes: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);
    try {
      [tokenRes, sessionRes] = await Promise.all([
        fetch(`${authServiceUrl}/sessions/${sessionId}/token`, {
          headers: serviceHeaders,
          signal: controller.signal,
          redirect: "error",
        }),
        fetch(`${authServiceUrl}/sessions/${sessionId}`, {
          headers: serviceHeaders,
          signal: controller.signal,
          redirect: "error",
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[terminal-proxy] auth: auth_service_unreachable session=${truncatedId}… → 502`);
    return {
      ok: false,
      value: {
        error: `Auth service unreachable: ${message}`,
        status: 502,
        reason: "auth_service_unreachable",
      },
    };
  }

  if (sessionRes.status === 404) {
    console.error(`[terminal-proxy] auth: session_not_found session=${truncatedId}… → 401`);
    return {
      ok: false,
      value: { error: "Session not found", status: 401, reason: "session_not_found" },
    };
  }

  if (tokenRes.status === 404) {
    console.error(`[terminal-proxy] auth: token_not_found session=${truncatedId}… → 401`);
    return {
      ok: false,
      value: { error: "Token not found", status: 401, reason: "token_not_found" },
    };
  }

  if (!tokenRes.ok) {
    console.error(
      `[terminal-proxy] auth: token_unavailable session=${truncatedId}… status=${tokenRes.status} → 502`,
    );
    return {
      ok: false,
      value: { error: "Token unavailable", status: 502, reason: "token_unavailable" },
    };
  }

  let tokenBody: CoderTokenResponse;
  try {
    tokenBody = (await tokenRes.json()) as CoderTokenResponse;
  } catch {
    console.error(
      `[terminal-proxy] auth: token_unavailable session=${truncatedId}… malformed_response → 502`,
    );
    return {
      ok: false,
      value: { error: "Malformed auth service response", status: 502, reason: "token_unavailable" },
    };
  }

  if (!tokenBody.token) {
    console.error(
      `[terminal-proxy] auth: token_unavailable session=${truncatedId}… incomplete_response → 502`,
    );
    return {
      ok: false,
      value: { error: "Incomplete token response", status: 502, reason: "token_unavailable" },
    };
  }

  if (!isConfiguredCoderUrl(tokenBody.coderUrl)) {
    console.error("[terminal-proxy] auth: coder_origin_mismatch → 401");
    return {
      ok: false,
      value: { error: "Coder deployment mismatch", status: 401, reason: "coder_origin_mismatch" },
    };
  }

  let username = "";
  try {
    const sessionBody = (await sessionRes.json()) as { username?: string };
    username = sessionBody.username ?? "";
  } catch {
    // Non-critical — proceed without username
  }

  const userLog = username ? ` user=${username}` : "";
  console.log(`[terminal-proxy] auth: session=${truncatedId}…${userLog} → authenticated`);

  return {
    ok: true,
    value: {
      token: tokenBody.token,
      coderUrl: getConfiguredCoderUrl(),
      sessionId,
      username,
    },
  };
}
