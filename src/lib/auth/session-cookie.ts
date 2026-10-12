import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieName,
  sessionCookieValues,
} from "@hive/auth";

export interface WritableSessionCookieStore {
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: "lax";
      path: string;
      maxAge: number;
      domain?: string;
    },
  ): void;
}

interface SessionCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
  domain?: string;
}

function isHiveScopedCookieDomain(domain: string): boolean {
  const normalizedDomain = domain.toLowerCase().replace(/^\./, "");
  return (
    normalizedDomain === "hive.local" ||
    normalizedDomain.startsWith("hive.") ||
    normalizedDomain.includes(".hive.")
  );
}

function normalizeHostname(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  const trimmed = hostname.trim().toLowerCase();
  if (!trimmed) return null;
  const bracketEndIndex = trimmed.indexOf("]");
  const withoutPort =
    trimmed.startsWith("[") && bracketEndIndex > 1
      ? trimmed.slice(1, bracketEndIndex)
      : trimmed.split(":")[0];
  if (!withoutPort || withoutPort === "localhost") return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(withoutPort)) return null;
  return withoutPort;
}

// Legacy domains are deletion targets only. Never set a live session with Domain.
export function sessionCookieDomainsToClear(hostname?: string | null): string[] {
  const host = normalizeHostname(hostname);
  const configured = process.env.COOKIE_DOMAIN?.trim().toLowerCase().replace(/^\./, "");
  const hiveIndex = host?.indexOf("hive.") ?? -1;
  const candidates = [
    configured && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(configured)
      ? `.${configured}`
      : undefined,
    host && isHiveScopedCookieDomain(host) ? `.${host}` : undefined,
    host && hiveIndex > 0 ? `.${host.slice(hiveIndex)}` : undefined,
  ];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

export function usesSecureSessionCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

function sessionCookieOptions(maxAge: number, domain?: string | null): SessionCookieOptions {
  const cookieDomain = domain ?? undefined;
  return {
    httpOnly: true,
    secure: usesSecureSessionCookies(),
    sameSite: "lax",
    path: "/",
    maxAge,
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  };
}

export const getSessionCookieValuesFromHeader = sessionCookieValues;

function serializeSessionCookie(
  name: string,
  value: string,
  options: SessionCookieOptions,
  now: Date = new Date(),
): string {
  const parts = [`${name}=${value}`];

  parts.push(`Path=${options.path}`);
  parts.push(`Max-Age=${options.maxAge}`);

  if (options.maxAge === 0) {
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  } else {
    parts.push(`Expires=${new Date(now.getTime() + options.maxAge * 1000).toUTCString()}`);
  }

  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  parts.push("SameSite=Lax");

  return parts.join("; ");
}

function appendSessionCookie(
  headers: Headers,
  name: string,
  value: string,
  options: SessionCookieOptions,
): void {
  headers.append("Set-Cookie", serializeSessionCookie(name, value, options));
}

export function appendSetSessionCookieHeaders(
  headers: Headers,
  signedValue: string,
  hostname?: string | null,
): void {
  appendClearLegacySessionCookieHeaders(headers, hostname);
  appendSessionCookie(
    headers,
    sessionCookieName(),
    signedValue,
    sessionCookieOptions(SESSION_MAX_AGE_SECONDS),
  );
}

function appendClearLegacySessionCookieHeaders(headers: Headers, hostname?: string | null): void {
  appendSessionCookie(headers, SESSION_COOKIE_NAME, "", sessionCookieOptions(0));
  for (const domain of sessionCookieDomainsToClear(hostname)) {
    appendSessionCookie(headers, SESSION_COOKIE_NAME, "", sessionCookieOptions(0, domain));
  }
}

export function appendClearSessionCookieHeaders(headers: Headers, hostname?: string | null): void {
  appendClearLegacySessionCookieHeaders(headers, hostname);
  if (sessionCookieName() !== SESSION_COOKIE_NAME) {
    appendSessionCookie(headers, sessionCookieName(), "", sessionCookieOptions(0));
  }
}

export function setSessionCookieValue(
  cookieStore: WritableSessionCookieStore,
  signedValue: string,
): void {
  cookieStore.set(sessionCookieName(), signedValue, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
}

export function clearSessionCookies(
  cookieStore: WritableSessionCookieStore,
  hostname?: string | null,
): void {
  cookieStore.set(sessionCookieName(), "", sessionCookieOptions(0));
  if (sessionCookieName() !== SESSION_COOKIE_NAME) {
    cookieStore.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0));
  }
  for (const domain of sessionCookieDomainsToClear(hostname)) {
    cookieStore.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0, domain));
  }
}
