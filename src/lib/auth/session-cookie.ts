import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@hive/auth";

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

function getCookieDomain(): string | undefined {
  const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
  if (!cookieDomain) return undefined;

  if (!isHiveScopedCookieDomain(cookieDomain)) {
    console.error(
      "[session-cookie] Refusing unsafe COOKIE_DOMAIN; use a Hive-specific parent such as .hive.local.kethalia.com",
    );
    return undefined;
  }

  return cookieDomain;
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

export function resolveSessionCookieDomain(hostname?: string | null): string | undefined {
  const configuredDomain = getCookieDomain();
  if (configuredDomain) return configuredDomain;

  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname || !isHiveScopedCookieDomain(normalizedHostname)) return undefined;

  return `.${normalizedHostname}`;
}

function parentHiveCookieDomain(hostname?: string | null): string | undefined {
  if (getCookieDomain()) return undefined;

  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) return undefined;

  const hiveIndex = normalizedHostname.indexOf("hive.");
  if (hiveIndex <= 0) return undefined;

  const parentDomain = `.${normalizedHostname.slice(hiveIndex)}`;
  return isHiveScopedCookieDomain(parentDomain) ? parentDomain : undefined;
}

function sessionCookieDomainsToClear(hostname?: string | null): string[] {
  const domain = resolveSessionCookieDomain(hostname);
  const parentDomain = parentHiveCookieDomain(hostname);
  return [domain, parentDomain].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
  );
}

export function usesSecureSessionCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

function sessionCookieOptions(
  maxAge: number,
  domain: string | null | undefined = resolveSessionCookieDomain(),
): SessionCookieOptions {
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

function remainingSessionCookieMaxAge(issuedAtMs?: number): number {
  if (!issuedAtMs) return SESSION_MAX_AGE_SECONDS;

  const expiresAtMs = issuedAtMs + SESSION_MAX_AGE_SECONDS * 1000;
  const remainingSeconds = Math.ceil((expiresAtMs - Date.now()) / 1000);
  return Math.max(0, Math.min(SESSION_MAX_AGE_SECONDS, remainingSeconds));
}

export function getSessionCookieValuesFromHeader(
  cookieHeader: string | null | undefined,
): string[] {
  if (!cookieHeader) return [];

  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;

    const name = part.slice(0, separatorIndex).trim();
    if (name !== SESSION_COOKIE_NAME) continue;

    const value = part.slice(separatorIndex + 1).trim();
    if (value) values.push(value);
  }

  return [...new Set(values)];
}

function serializeSessionCookie(
  value: string,
  options: SessionCookieOptions,
  now: Date = new Date(),
): string {
  const parts = [`${SESSION_COOKIE_NAME}=${value}`];

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

function appendSessionCookie(headers: Headers, value: string, options: SessionCookieOptions): void {
  headers.append("Set-Cookie", serializeSessionCookie(value, options));
}

export function appendSetSessionCookieHeaders(
  headers: Headers,
  signedValue: string,
  hostname?: string | null,
): void {
  const domain = resolveSessionCookieDomain(hostname);

  if (domain) {
    appendSessionCookie(headers, "", sessionCookieOptions(0, null));
  }
  for (const domainToClear of sessionCookieDomainsToClear(hostname)) {
    appendSessionCookie(headers, "", sessionCookieOptions(0, domainToClear));
  }

  appendSessionCookie(headers, signedValue, sessionCookieOptions(SESSION_MAX_AGE_SECONDS, domain));
}

export function appendClearSessionCookieHeaders(headers: Headers, hostname?: string | null): void {
  for (const domainToClear of sessionCookieDomainsToClear(hostname)) {
    appendSessionCookie(headers, "", sessionCookieOptions(0, domainToClear));
  }

  appendSessionCookie(headers, "", sessionCookieOptions(0, null));
}

export function setSessionCookieValue(
  cookieStore: WritableSessionCookieStore,
  signedValue: string,
  hostname?: string | null,
): void {
  const domain = resolveSessionCookieDomain(hostname);

  cookieStore.set(
    SESSION_COOKIE_NAME,
    signedValue,
    sessionCookieOptions(SESSION_MAX_AGE_SECONDS, domain),
  );
}

export function refreshDomainSessionCookie(
  cookieStore: WritableSessionCookieStore,
  signedValue: string,
  issuedAtMs?: number,
  hostname?: string | null,
): void {
  const domain = resolveSessionCookieDomain(hostname);
  if (!domain) return;

  const maxAge = remainingSessionCookieMaxAge(issuedAtMs);
  if (maxAge <= 0) return;

  cookieStore.set(SESSION_COOKIE_NAME, signedValue, sessionCookieOptions(maxAge, domain));
}

export function clearSessionCookies(
  cookieStore: WritableSessionCookieStore,
  hostname?: string | null,
): void {
  cookieStore.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0, null));

  for (const domainToClear of sessionCookieDomainsToClear(hostname)) {
    cookieStore.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0, domainToClear));
  }
}
