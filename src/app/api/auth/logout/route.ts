import { NextResponse } from "next/server";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { getRequestSession } from "@/lib/auth/session";
import { appendClearSessionCookieHeaders } from "@/lib/auth/session-cookie";

export async function POST() {
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
  appendClearSessionCookieHeaders(response.headers);
  return response;
}
