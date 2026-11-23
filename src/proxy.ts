import { coderAuthCookieValues, verifyCookie } from "@hive/auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { appPreviewBuildPath } from "./lib/app-preview-origin.mjs";
import { validCoderAuthCookie } from "./lib/auth/better-auth-cookie";
import { getSessionCookieValuesFromHeader } from "./lib/auth/session-cookie";
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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    pathname.match(/\.(?:svg|png|jpg|jpeg|gif|ico|css|js|woff2?|ttf)$/)
  ) {
    return withContentSecurityPolicy(NextResponse.next());
  }

  if (
    // These APIs enforce their own access policy and return JSON errors.
    pathname.startsWith("/api/discovery/") ||
    pathname === "/api/app-previews" ||
    pathname === appPreviewBuildPath ||
    pathname === "/api/projects" ||
    pathname === "/api/projects/open" ||
    /^\/api\/delivery\/(?:host|native)$/.test(pathname) ||
    /^\/api\/projects\/[0-9a-f-]+\/(?:session-grant|terminal-grant|tasks\/(?:start|status|retry|cleanup))$/i.test(
      pathname,
    ) ||
    /^\/api\/codex-host\/guardians(?:\/recover-empty)?$/.test(pathname) ||
    /^\/api\/codex-host\/registrations(?:\/[0-9a-f-]+\/heartbeat)?$/i.test(pathname) ||
    /^\/api\/workspaces\/[^/]+\/(?:codex-account|claude-account|build-logs)$/.test(pathname) ||
    pathname === "/api/github/connection" ||
    pathname === "/api/notifications/events" ||
    pathname === "/" ||
    PUBLIC_PATHS.some((path) => pathname.startsWith(path))
  ) {
    return withContentSecurityPolicy(NextResponse.next());
  }

  const sessionCookieValues = getSessionCookieValuesFromHeader(request.headers.get("cookie"));
  const oauthEnabled = process.env.HIVE_CODER_OAUTH_ENABLED === "true";
  const hasCoderAuthCookie =
    oauthEnabled && coderAuthCookieValues(request.headers.get("cookie")).length > 0;
  if (oauthEnabled && !hasCoderAuthCookie)
    return withContentSecurityPolicy(NextResponse.redirect(new URL("/login", request.url)));
  if (!hasCoderAuthCookie && (sessionCookieValues.length !== 1 || !sessionCookieValues[0])) {
    const loginUrl = new URL("/login", request.url);
    return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[proxy] COOKIE_SECRET is not configured");
    const loginUrl = new URL("/login", request.url);
    return withContentSecurityPolicy(NextResponse.redirect(loginUrl));
  }

  const verifiedSessionCookie = hasCoderAuthCookie
    ? await validCoderAuthCookie(request.headers.get("cookie"), cookieSecret)
    : verifyCookie(sessionCookieValues[0], cookieSecret);

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
