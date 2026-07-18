import { NextResponse } from "next/server";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { getRequestSession } from "@/lib/auth/session";
import { appendClearSessionCookieHeaders } from "@/lib/auth/session-cookie";
import { CODER_HOST_COOKIE } from "@/lib/security/content-security-policy";

export async function POST(request: Request) {
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
  response.cookies.set(CODER_HOST_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    sameSite: "lax",
    secure: true,
    path: "/",
  });
  appendClearSessionCookieHeaders(response.headers, new URL(request.url).hostname);
  return response;
}
