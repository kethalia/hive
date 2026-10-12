import { sessionCookieName, signCookie, verifyCookie } from "@hive/auth";
import { cookies, headers } from "next/headers";
import { getAuthServiceClient } from "./service-client";
import {
  clearSessionCookies,
  getSessionCookieValuesFromHeader,
  setSessionCookieValue,
  type WritableSessionCookieStore,
} from "./session-cookie";

export type SessionData = import("@hive/auth").SessionData;

interface SessionCookieReader {
  get(name: string): { value: string } | undefined;
  getAll?(name: string): { value: string }[];
}

export async function getRequestSession(): Promise<SessionData | null> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return getSession(cookieStore, headerStore.get("cookie"));
}

export async function getSession(
  cookieStore: SessionCookieReader,
  cookieHeader?: string | null,
): Promise<SessionData | null> {
  const cookieValues = getSessionCookieValues(cookieStore, cookieHeader);
  if (cookieValues.length !== 1 || !cookieValues[0]) {
    return null;
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[session] COOKIE_SECRET is not configured");
    return null;
  }

  const result = verifyCookie(cookieValues[0], cookieSecret);
  if (!result) {
    console.log("[session] Cookie verification failed");
    return null;
  }
  let payload: Awaited<ReturnType<ReturnType<typeof getAuthServiceClient>["getSession"]>>;
  try {
    payload = await getAuthServiceClient().getSession(result.sessionId);
  } catch {
    console.log("[session] Auth service error, treating as unauthenticated");
    return null;
  }
  if (!payload) return null;
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

function getSessionCookieValues(
  cookieStore: SessionCookieReader,
  cookieHeader?: string | null,
): string[] {
  const rawCookieValues = getSessionCookieValuesFromHeader(cookieHeader);
  if (cookieHeader != null) return rawCookieValues;

  const cookies = cookieStore.getAll?.(sessionCookieName());
  const values = cookies?.map((cookie) => cookie.value) ?? [];

  if (values.length === 0) {
    const cookie = cookieStore.get(sessionCookieName());
    if (cookie?.value) values.push(cookie.value);
  }

  return values;
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
