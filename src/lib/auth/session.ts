import {
  signCookie,
  verifyCookie,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_DAYS,
  SESSION_MAX_AGE_SECONDS,
} from "@hive/auth";
import type { SessionData } from "@hive/auth";
import { getAuthServiceClient } from "./service-client";

export async function getSession(
  cookieStore: { get(name: string): { value: string } | undefined },
): Promise<SessionData | null> {
  const cookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!cookie) {
    return null;
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[session] COOKIE_SECRET is not configured");
    return null;
  }

  const result = verifyCookie(cookie.value, cookieSecret);
  if (!result) {
    console.log("[session] Cookie verification failed");
    return null;
  }

  let payload;
  try {
    payload = await getAuthServiceClient().getSession(result.sessionId);
  } catch {
    console.log("[session] Auth service error, treating as unauthenticated");
    return null;
  }

  if (!payload) {
    console.log(
      `[session] Not found for sessionId=${result.sessionId.slice(0, 8)}…`,
    );
    return null;
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

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await getAuthServiceClient().logout(sessionId);
  } catch {
    console.log("[logout] Auth service error during session deletion");
  }
}

export function setSessionCookie(
  cookieStore: {
    set(name: string, value: string, options: Record<string, unknown>): void;
  },
  sessionId: string,
): void {
  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    throw new Error("COOKIE_SECRET is not configured");
  }
  const signedValue = signCookie(sessionId, cookieSecret);
  cookieStore.set(SESSION_COOKIE_NAME, signedValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(
  cookieStore: {
    set(name: string, value: string, options: Record<string, unknown>): void;
  },
): void {
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
