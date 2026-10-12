import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const TERMINAL_TICKET_TTL_MS = 30_000;
const PURPOSE = "hive-terminal-ticket-v1";

interface Claims {
  sessionId: string;
  audience: string;
  origin: string;
  requestTargetHash: string;
  issuedAt: number;
  expiresAt: number;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${PURPOSE}:${payload}`).digest("base64url");
}

export function createTerminalTicket(
  claims: Omit<Claims, "issuedAt" | "expiresAt" | "requestTargetHash"> & { requestTarget: string },
  secret: string,
  sessionExpiresAt: number,
  now = Date.now(),
): string {
  if (
    !secret ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sessionId) ||
    !Number.isSafeInteger(sessionExpiresAt) ||
    sessionExpiresAt <= now
  )
    throw new Error("Cannot authorize terminal connection.");
  const { requestTarget, ...identity } = claims;
  const payload = Buffer.from(
    JSON.stringify({
      ...identity,
      // A clone proof embeds its path again. Hash the complete target so large
      // supported URLs still produce compact, request-bound handshake tickets.
      requestTargetHash: createHash("sha256").update(requestTarget).digest("base64url"),
      issuedAt: now,
      expiresAt: Math.min(sessionExpiresAt, now + TERMINAL_TICKET_TTL_MS),
    }),
  ).toString("base64url");
  const ticket = `${payload}.${signature(payload, secret)}`;
  if (ticket.length > 4096) throw new Error("Terminal request is too large.");
  return ticket;
}

export function verifyTerminalTicket(
  ticket: string,
  secret: string,
  expected: { audience: string; origin?: string; requestTarget: string },
  now = Date.now(),
): Claims | null {
  if (!secret || ticket.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket))
    return null;
  const [payload, mac] = ticket.split(".");
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(signature(payload, secret)))) return null;
  try {
    const claims: Claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      !claims ||
      typeof claims.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sessionId) ||
      claims.audience !== expected.audience ||
      typeof claims.origin !== "string" ||
      (expected.origin !== undefined && claims.origin !== expected.origin) ||
      claims.requestTargetHash !==
        createHash("sha256").update(expected.requestTarget).digest("base64url") ||
      !Number.isSafeInteger(claims.issuedAt) ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.issuedAt > now + 5000 ||
      claims.expiresAt <= now ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > TERMINAL_TICKET_TTL_MS
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}

// These exact loopback authorities support the shipped local Compose stack.
// Do not accept DNS suffix matches or private-network addresses as loopback.
export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase());
}
