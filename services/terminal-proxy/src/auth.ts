import type { IncomingMessage } from "node:http";
import { verifyCookie } from "@hive/auth";
import type { CoderTokenResponse } from "@hive/auth";

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

export type AuthResult =
  | { ok: true; value: AuthSuccess }
  | { ok: false; value: AuthFailure };

function parseCookie(header: string, name: string): string | null {
  const pairs = header.split(";");
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (key === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}

export async function authenticateUpgrade(
  req: IncomingMessage,
): Promise<AuthResult> {
  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[terminal-proxy] auth: COOKIE_SECRET not configured → 502");
    return {
      ok: false,
      value: { error: "Server misconfigured", status: 502, reason: "cookie_secret_missing" },
    };
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    console.error("[terminal-proxy] auth: no_cookie → 401");
    return {
      ok: false,
      value: { error: "No cookie provided", status: 401, reason: "no_cookie" },
    };
  }

  const cookieValue = parseCookie(cookieHeader, "hive-session");
  if (!cookieValue) {
    console.error("[terminal-proxy] auth: no_cookie → 401");
    return {
      ok: false,
      value: { error: "No hive-session cookie", status: 401, reason: "no_cookie" },
    };
  }

  const verified = verifyCookie(cookieValue, cookieSecret);
  if (!verified) {
    console.error("[terminal-proxy] auth: invalid_hmac → 401");
    return {
      ok: false,
      value: { error: "Invalid cookie signature", status: 401, reason: "invalid_hmac" },
    };
  }

  const { sessionId } = verified;
  const truncatedId = sessionId.slice(0, 8);

  const authServiceUrl = (
    process.env.AUTH_SERVICE_URL ?? "http://localhost:4400"
  ).replace(/\/+$/, "");

  let tokenRes: Response;
  let sessionRes: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);
    [tokenRes, sessionRes] = await Promise.all([
      fetch(`${authServiceUrl}/sessions/${sessionId}/token`, {
        signal: controller.signal,
      }),
      fetch(`${authServiceUrl}/sessions/${sessionId}`, {
        signal: controller.signal,
      }),
    ]);
    clearTimeout(timeoutId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[terminal-proxy] auth: auth_service_unreachable session=${truncatedId}… → 502`,
    );
    return {
      ok: false,
      value: {
        error: `Auth service unreachable: ${message}`,
        status: 502,
        reason: "auth_service_unreachable",
      },
    };
  }

  if (tokenRes.status === 404 || sessionRes.status === 404) {
    console.error(
      `[terminal-proxy] auth: session_not_found session=${truncatedId}… → 401`,
    );
    return {
      ok: false,
      value: { error: "Session not found", status: 401, reason: "session_not_found" },
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

  if (!tokenBody.token || !tokenBody.coderUrl) {
    console.error(
      `[terminal-proxy] auth: token_unavailable session=${truncatedId}… incomplete_response → 502`,
    );
    return {
      ok: false,
      value: { error: "Incomplete token response", status: 502, reason: "token_unavailable" },
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
  console.log(
    `[terminal-proxy] auth: session=${truncatedId}…${userLog} → authenticated`,
  );

  return {
    ok: true,
    value: {
      token: tokenBody.token,
      coderUrl: tokenBody.coderUrl,
      sessionId,
      username,
    },
  };
}
