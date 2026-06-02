import { SESSION_COOKIE_NAME, signCookie, verifyCookie } from "@hive/auth";
import { getAuthServiceClient } from "./service-client";
import {
  clearSessionCookies,
  setSessionCookieValue,
  type WritableSessionCookieStore,
} from "./session-cookie";

export type SessionData = import("@hive/auth").SessionData;

interface SessionCookieReader {
  get(name: string): { value: string } | undefined;
  getAll?(name: string): { value: string }[];
}

export async function getSession(cookieStore: SessionCookieReader): Promise<SessionData | null> {
  const cookieValues = getSessionCookieValues(cookieStore);
  if (cookieValues.length === 0) {
    return null;
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[session] COOKIE_SECRET is not configured");
    return null;
  }

  let sawInvalidCookie = false;
  for (const cookieValue of cookieValues) {
    const result = verifyCookie(cookieValue, cookieSecret);
    if (!result) {
      sawInvalidCookie = true;
      continue;
    }

    let payload: Awaited<ReturnType<ReturnType<typeof getAuthServiceClient>["getSession"]>>;
    try {
      payload = await getAuthServiceClient().getSession(result.sessionId);
    } catch {
      console.log("[session] Auth service error, treating as unauthenticated");
      return null;
    }

    if (!payload) {
      console.log(`[session] Not found for sessionId=${result.sessionId.slice(0, 8)}…`);
      continue;
    }

    return {
      user: {
        id: payload.userId,
        coderUrl: payload.coderUrl,
        coderUserId: payload.coderUserId,
        username: payload.username,
        email: payload.email,
      },
      session: {
        id: payload.sessionId,
        sessionId: payload.sessionId,
        expiresAt: new Date(payload.expiresAt),
      },
    };
  }

  if (sawInvalidCookie) {
    console.log("[session] Cookie verification failed");
  }
  return null;
}

function getSessionCookieValues(cookieStore: SessionCookieReader): string[] {
  const cookies = cookieStore.getAll?.(SESSION_COOKIE_NAME);
  const values = cookies?.map((cookie) => cookie.value).filter(Boolean) ?? [];

  if (values.length === 0) {
    const cookie = cookieStore.get(SESSION_COOKIE_NAME);
    if (cookie?.value) values.push(cookie.value);
  }

  return [...new Set(values)];
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await getAuthServiceClient().logout(sessionId);
  } catch {
    console.log("[logout] Auth service error during session deletion");
  }
}

export function createSignedSessionCookie(sessionId: string): string {
  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    throw new Error("COOKIE_SECRET is not configured");
  }
  return signCookie(sessionId, cookieSecret);
}

export function setSessionCookie(cookieStore: WritableSessionCookieStore, sessionId: string): void {
  setSessionCookieValue(cookieStore, createSignedSessionCookie(sessionId));
}

export function clearSessionCookie(cookieStore: WritableSessionCookieStore): void {
  clearSessionCookies(cookieStore);
}
