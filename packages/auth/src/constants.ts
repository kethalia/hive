export const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export const TOKEN_EXPIRY_WARNING_HOURS = 48;

export const SESSION_MAX_AGE_DAYS = 30;

export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

export const ENCRYPTION_ALGORITHM = "aes-256-gcm";

export const IV_LENGTH = 12;

export const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

export const SESSION_COOKIE_NAME = "hive-session";

export const SECURE_SESSION_COOKIE_NAME = "__Host-hive-session";

export function sessionCookieName(): string {
  return process.env.NODE_ENV === "production" ? SECURE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

// Preserve every occurrence, including empty/identical values: Cookie headers
// contain no Domain/Path metadata with which to select a trustworthy duplicate.
export function sessionCookieValues(header: string | null | undefined): string[] {
  const name = sessionCookieName();
  return (header ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === name
      ? [part.slice(separator + 1).trim()]
      : [];
  });
}
