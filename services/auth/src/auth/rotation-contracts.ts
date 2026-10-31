import { TOKEN_LIFETIME_SECONDS } from "@hive/auth";
import type { CoderToken, User } from "@hive/db";

export const ROTATION_LIMITS = {
  scan: 20,
  mints: 2,
  invocationMs: 80_000,
  leaseMs: 120_000,
  sweepMs: 3_600_000,
  providerMs: 10_000,
  providerBytes: 16_384,
} as const;

export type RotationToken = CoderToken & { user: User };
export type RotationClaim = {
  id: string;
  configuredOrigin: string;
  holder: string;
  generation: number;
  afterId: string | null;
};
export type RotationOperation = {
  id: string;
  ownerId: string;
  tokenId: string;
  tokenVersion: number;
  coderUserId: string;
  configuredOrigin: string;
  holder: string;
  generation: number;
};
export class RotationLeaseLost extends Error {
  constructor() {
    super("rotation_lease_lost");
  }
}

export function rotationTiming(token: RotationToken, now: number) {
  const expiresAt =
    token.expiresAt?.getTime() ?? token.createdAt.getTime() + TOKEN_LIFETIME_SECONDS * 1000;
  const issuedAt = token.expiresAt ? token.updatedAt.getTime() : token.createdAt.getTime();
  const lifetime = Math.min(TOKEN_LIFETIME_SECONDS * 1000, Math.max(0, expiresAt - issuedAt));
  return {
    expiresAt,
    eligible: expiresAt > now && now >= expiresAt - lifetime * 0.25,
    notify: expiresAt > now && expiresAt - now <= 24 * 3600_000,
  };
}
