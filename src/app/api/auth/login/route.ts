import { getConfiguredCoderUrl, isConfiguredCoderUrl, SESSION_MAX_AGE_SECONDS } from "@hive/auth";
import { NextResponse } from "next/server";
import { getClientIp, loginSchema } from "@/lib/auth/login";
import { loginRateLimiter } from "@/lib/auth/rate-limit";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { createSignedSessionCookie } from "@/lib/auth/session";
import { appendSetSessionCookieHeaders, usesSecureSessionCookies } from "@/lib/auth/session-cookie";
import {
  CODER_HOST_COOKIE,
  coderFrameConfiguredUrls,
} from "@/lib/security/content-security-policy";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid login input" }, { status: 400 });
  }

  const { email, password } = parsed.data;
  const cloudflare = process.env.HIVE_RUNTIME_TARGET === "cloudflare";
  // Cloudflare supplies this header at ingress. Do not accept browser-provided
  // X-Forwarded-For/X-Hive-Client-IP as the Worker caller's identity.
  const ip = cloudflare
    ? (request.headers.get("CF-Connecting-IP") ?? "unknown")
    : getClientIp(request.headers);
  const rateCheck = loginRateLimiter.check(ip);
  if (!rateCheck.allowed) {
    console.log(`[login] Rate limited IP: ${ip}`);
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      { status: 429 },
    );
  }

  try {
    const coderUrl = getConfiguredCoderUrl();
    const client = getAuthServiceClient();
    const result = cloudflare
      ? await client.login({ email, password }, ip)
      : await client.login({ email, password });
    if (!isConfiguredCoderUrl(result.user.coderUrl)) {
      throw new Error("Authentication service Coder origin does not match this deployment");
    }
    const response = NextResponse.json({ success: true as const });
    const coderFrameUrls = coderFrameConfiguredUrls(coderUrl, result.applicationsHost).join("~");
    response.cookies.set(CODER_HOST_COOKIE, coderFrameUrls, {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      sameSite: "lax",
      secure: usesSecureSessionCookies(),
      path: "/",
    });
    appendSetSessionCookieHeaders(
      response.headers,
      createSignedSessionCookie(result.sessionId),
      new URL(request.url).hostname,
    );
    console.log(`[login] Login successful for ${email}`);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed";
    console.log(`[login] Login failed for ${email}: ${message}`);
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
