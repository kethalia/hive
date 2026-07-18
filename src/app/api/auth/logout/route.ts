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
  appendClearSessionCookieHeaders(response.headers, new URL(request.url).hostname);
  response.headers.append(
    "set-cookie",
    `${CODER_HOST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
  return response;
}
