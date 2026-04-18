import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SESSION_COOKIE_NAME = "hive-session";
const SESSION_MAX_AGE_DAYS = 30;
const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

export interface SessionData {
  user: {
    id: string;
    coderUrl: string;
    coderUserId: string;
    username: string;
    email: string;
  };
  session: {
    id: string;
    sessionId: string;
    expiresAt: Date;
  };
}

export async function createSession(userId: string): Promise<string> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.create({
    data: {
      sessionId,
      userId,
      expiresAt,
    },
  });

  return sessionId;
}

export async function getSession(
  cookieStore: { get(name: string): { value: string } | undefined }
): Promise<SessionData | null> {
  const cookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!cookie) {
    return null;
  }

  const sessionId = cookie.value;

  const session = await prisma.session.findUnique({
    where: { sessionId },
    include: { user: true },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { sessionId } });
    return null;
  }

  return {
    user: {
      id: session.user.id,
      coderUrl: session.user.coderUrl,
      coderUserId: session.user.coderUserId,
      username: session.user.username,
      email: session.user.email,
    },
    session: {
      id: session.id,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    },
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { sessionId } });
}

export function setSessionCookie(
  cookieStore: {
    set(
      name: string,
      value: string,
      options: Record<string, unknown>
    ): void;
  },
  sessionId: string
): void {
  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(
  cookieStore: {
    set(
      name: string,
      value: string,
      options: Record<string, unknown>
    ): void;
  }
): void {
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
