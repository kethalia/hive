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

function getCookieDomain(): string | undefined {
  const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
  return cookieDomain || undefined;
}

function sessionCookieOptions(
  maxAge: number,
  domain: string | null | undefined = getCookieDomain(),
) {
  const cookieDomain = domain ?? undefined;
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  };
}

export function setSessionCookieValue(
  cookieStore: WritableSessionCookieStore,
  signedValue: string,
): void {
  const domain = getCookieDomain();

  if (domain) {
    // Remove any pre-domain-migration host-only cookie for the web host so
    // subsequent requests do not carry two hive-session cookies with different
    // scopes.
    cookieStore.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0, null));
  }

  cookieStore.set(
    SESSION_COOKIE_NAME,
    signedValue,
    sessionCookieOptions(SESSION_MAX_AGE_SECONDS, domain),
  );
}

export function refreshDomainSessionCookie(
  cookieStore: WritableSessionCookieStore,
  signedValue: string,
): void {
  const domain = getCookieDomain();
  if (!domain) return;

  cookieStore.set(
    SESSION_COOKIE_NAME,
    signedValue,
    sessionCookieOptions(SESSION_MAX_AGE_SECONDS, domain),
  );
}

export function clearSessionCookies(cookieStore: WritableSessionCookieStore): void {
  const domain = getCookieDomain();

  if (domain) {
    cookieStore.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0, domain));
  }

  cookieStore.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0, null));
}
