import { createHmac, timingSafeEqual } from "node:crypto";

export function signCookie(sessionId: string, secret: string): string {
  const timestamp = Date.now();
  const payload = `${sessionId}.${timestamp}`;
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
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
  if (!sessionId || !timestampStr || !providedHmac) return null;

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) return null;

  const payload = `${sessionId}.${timestampStr}`;
  const expectedHmac = createHmac("sha256", secret).update(payload).digest("hex");

  const expectedBuf = Buffer.from(expectedHmac, "hex");
  const providedBuf = Buffer.from(providedHmac, "hex");

  if (expectedBuf.length !== providedBuf.length) return null;

  if (!timingSafeEqual(expectedBuf, providedBuf)) return null;

  return { sessionId, timestamp };
}
