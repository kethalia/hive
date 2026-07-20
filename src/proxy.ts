import { verifyCookie } from "@hive/auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getSessionCookieValuesFromHeader,
  refreshDomainSessionCookie,
} from "./lib/auth/session-cookie";
import {
  buildContentSecurityPolicy,
  buildPermissionsPolicy,
  CODER_HOST_COOKIE,
} from "./lib/security/content-security-policy";

const PUBLIC_PATHS = ["/login", "/api/auth", "/manifest.webmanifest", "/robots.txt"];
const STATIC_PREFIXES = ["/_next", "/favicon.ico"];
const WORKSPACE_PROXY_PREFIX = "/api/workspace-proxy/";
const WORKSPACE_PROXY_GRANT_HEADER = "x-hive-workspace-proxy-grant";

function withContentSecurityPolicy(
  response: NextResponse,
  coderFrameUrls: readonly string[] = [],
): NextResponse {
  response.headers.set("Content-Security-Policy", buildContentSecurityPolicy(coderFrameUrls));
  response.headers.set("Permissions-Policy", buildPermissionsPolicy(coderFrameUrls));
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith(WORKSPACE_PROXY_PREFIX) &&
    (request.method === "OPTIONS" || request.headers.has(WORKSPACE_PROXY_GRANT_HEADER))
  ) {
    return withContentSecurityPolicy(NextResponse.next());
  }

  if (
    STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    pathname.match(/\.(?:svg|png|jpg|jpeg|gif|ico|css|js|woff2?|ttf)$/)
  ) {
    return withContentSecurityPolicy(NextResponse.next());
  }

  if (pathname === "/" || PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return withContentSecurityPolicy(NextResponse.next());
  }

  const sessionCookieValues = getSessionCookieValuesFromHeader(request.headers.get("cookie"));
  if (sessionCookieValues.length === 0) {
    const loginUrl = new URL("/login", request.url);
    return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[proxy] COOKIE_SECRET is not configured");
    const loginUrl = new URL("/login", request.url);
    return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
  }

  const verifiedSessionCookie = [...new Set(sessionCookieValues)]
    .flatMap((value) => {
      const verified = verifyCookie(value, cookieSecret);
      return verified ? [{ value, verified }] : [];
    })
    .sort((left, right) => right.verified.timestamp - left.verified.timestamp)[0];

  if (verifiedSessionCookie) {
    const response = NextResponse.next();
    const coderFrameUrls =
      request.cookies
        .get(CODER_HOST_COOKIE)
        ?.value.split("~")
        .map((value) => (value.includes("://") ? value : `https://${value}`)) ?? [];
    withContentSecurityPolicy(response, coderFrameUrls);
    refreshDomainSessionCookie(
      response.cookies,
      verifiedSessionCookie.value,
      verifiedSessionCookie.verified.timestamp,
      request.nextUrl.hostname,
    );
    return response;
  }

  const loginUrl = new URL("/login", request.url);
  return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
