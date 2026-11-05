import { createHmac, timingSafeEqual } from "node:crypto";
import { HEX_64_RE } from "./constants";

// Invalidate previously shared cookies even if a stolen value is renamed to
// __Host-hive-session by a non-browser client during the migration.
const COOKIE_SIGNATURE_PURPOSE = "hive-host-only-session-v1:";

export function signCookie(sessionId: string, secret: string): string {
  const timestamp = Date.now();
  const payload = `${sessionId}.${timestamp}`;
  const hmac = createHmac("sha256", secret)
    .update(COOKIE_SIGNATURE_PURPOSE + payload)
    .digest("hex");
  return `${payload}.${hmac}`;
}

export function verifyCookie(
  cookie: string,
  secret: string,
): { sessionId: string; timestamp: number } | null {
  if (!cookie) return null;

  const parts = cookie.split(".");
  if (parts.length !== 3) return null;

  const [sessionId, timestampStr, providedHmac] = parts;
  // Buffer's hex decoder silently truncates malformed or odd-length suffixes.
  // Validate the complete signature before decoding it for comparison.
  if (!sessionId || !timestampStr || !HEX_64_RE.test(providedHmac)) return null;

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) return null;

  const payload = `${sessionId}.${timestampStr}`;
  const expectedHmac = createHmac("sha256", secret)
    .update(COOKIE_SIGNATURE_PURPOSE + payload)
    .digest("hex");

  const expectedBuf = Buffer.from(expectedHmac, "hex");
  const providedBuf = Buffer.from(providedHmac, "hex");

  if (expectedBuf.length !== providedBuf.length) return null;

  if (!timingSafeEqual(expectedBuf, providedBuf)) return null;

  return { sessionId, timestamp };
}
