import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyCookie } from "@hive/auth";

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

  const sessionCookie = request.cookies.get("hive-session");
  if (!sessionCookie?.value) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret) {
    console.error("[middleware] COOKIE_SECRET is not configured");
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  const verified = verifyCookie(sessionCookie.value, cookieSecret);
  if (!verified) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const runtime = "nodejs";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
