import { verifyCookie } from "@hive/auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionCookieValuesFromHeader } from "./lib/auth/session-cookie";
import { isHostCallbackTransport } from "./lib/codex-session/host-callback-transport";
import {
  buildContentSecurityPolicy,
  buildPermissionsPolicy,
  CODER_FRAME_HOSTS_REQUEST_HEADER,
  CODER_HOST_COOKIE,
} from "./lib/security/content-security-policy";

const PUBLIC_PATHS = ["/login", "/api/auth", "/manifest.webmanifest", "/robots.txt"];
const STATIC_PREFIXES = ["/_next", "/favicon.ico"];

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
    STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    pathname.match(/\.(?:svg|png|jpg|jpeg|gif|ico|css|js|woff2?|ttf)$/)
  ) {
    return withContentSecurityPolicy(NextResponse.next());
  }

  if (
    // These exact native transports authenticate their issuer/host signatures
    // in the route. Browser cookies cannot replace that separate authority.
    isHostCallbackTransport(request, process.env.HIVE_CODEX_GATEWAY_ENABLED) ||
    // Discovery authenticates in its route and must return JSON 401, not login HTML.
    pathname.startsWith("/api/discovery/") ||
    // This exact read endpoint authenticates its session in the route and
    // returns typed JSON failures rather than a login-page redirect.
    (request.method === "GET" && pathname === "/api/settings/window") ||
    pathname === "/api/notifications/events" ||
    pathname === "/" ||
    PUBLIC_PATHS.some((path) => pathname.startsWith(path))
  ) {
    return withContentSecurityPolicy(NextResponse.next());
  }

  const sessionCookieValues = getSessionCookieValuesFromHeader(request.headers.get("cookie"));
  if (sessionCookieValues.length !== 1 || !sessionCookieValues[0]) {
    const loginUrl = new URL("/login", request.url);
    return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[proxy] COOKIE_SECRET is not configured");
    const loginUrl = new URL("/login", request.url);
    return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
  }

  const verifiedSessionCookie = verifyCookie(sessionCookieValues[0], cookieSecret);

  if (verifiedSessionCookie) {
    const coderFrameUrls =
      request.cookies
        .get(CODER_HOST_COOKIE)
        ?.value.split("~")
        .map((value) => (value.includes("://") ? value : `https://${value}`)) ?? [];
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(CODER_FRAME_HOSTS_REQUEST_HEADER, coderFrameUrls.join("~"));
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    withContentSecurityPolicy(response, coderFrameUrls);
    return response;
  }

  const loginUrl = new URL("/login", request.url);
  return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
