import { coderAuthCookieValues } from "@hive/auth";
import { getDb } from "@hive/db";
import { NextResponse } from "next/server";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { getRequestSession } from "@/lib/auth/session";
import {
  appendClearSessionCookieHeaders,
  usesSecureSessionCookies,
} from "@/lib/auth/session-cookie";
import { CODER_HOST_COOKIE } from "@/lib/security/content-security-policy";
import { createCoderAuth } from "../../../../../services/auth/src/auth/better-auth";

export async function POST(request: Request) {
  const coderCookie = coderAuthCookieValues(request.headers.get("Cookie"));
  if (
    process.env.HIVE_CODER_OAUTH_ENABLED === "true" &&
    request.headers.get("Origin") !== process.env.HIVE_PUBLIC_ORIGIN
  )
    return NextResponse.json({ error: "Origin rejected" }, { status: 403 });
  let authResponse: Response | undefined;
  if (coderCookie.length && process.env.HIVE_CODER_OAUTH_ENABLED === "true") {
    authResponse = await createCoderAuth(getDb()).handler(
      new Request(`${process.env.HIVE_PUBLIC_ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          Cookie: request.headers.get("Cookie") ?? "",
          Origin: process.env.HIVE_PUBLIC_ORIGIN ?? "",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    if (!authResponse.ok)
      return NextResponse.json({ error: "Could not sign out. Try again." }, { status: 503 });
  }
  const session = await getRequestSession();

  if (session) {
    try {
      await getAuthServiceClient().logout(session.session.sessionId);
      console.log(`[logout] Session deleted for user ${session.user.id}`);
    } catch (error) {
      console.error(`[logout] Auth service error for user ${session.user.id}:`, error);
    }
  }

  const response = NextResponse.json({ success: true as const });
  for (const value of authResponse?.headers.getSetCookie() ?? [])
    response.headers.append("Set-Cookie", value);
  response.cookies.set(CODER_HOST_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    sameSite: "lax",
    secure: usesSecureSessionCookies(),
    path: "/",
  });
  appendClearSessionCookieHeaders(response.headers, new URL(request.url).hostname);
  return response;
}
