import { verifyCookie } from "@hive/auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getSessionCookieValuesFromHeader,
  refreshDomainSessionCookie,
} from "./lib/auth/session-cookie";

const PUBLIC_PATHS = ["/login", "/api/auth", "/manifest.webmanifest"];
const STATIC_PREFIXES = ["/_next", "/favicon.ico"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    pathname.match(/\.(?:svg|png|jpg|jpeg|gif|ico|css|js|woff2?)$/)
  ) {
    return NextResponse.next();
  }

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const sessionCookieValues = getSessionCookieValuesFromHeader(request.headers.get("cookie"));
  if (sessionCookieValues.length === 0) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[middleware] COOKIE_SECRET is not configured");
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  const verifiedSessionCookie = [...new Set(sessionCookieValues)]
    .flatMap((value) => {
      const verified = verifyCookie(value, cookieSecret);
      return verified ? [{ value, verified }] : [];
    })
    .sort((left, right) => right.verified.timestamp - left.verified.timestamp)[0];

  if (verifiedSessionCookie) {
    const response = NextResponse.next();
    refreshDomainSessionCookie(
      response.cookies,
      verifiedSessionCookie.value,
      verifiedSessionCookie.verified.timestamp,
    );
    return response;
  }

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const runtime = "nodejs";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
