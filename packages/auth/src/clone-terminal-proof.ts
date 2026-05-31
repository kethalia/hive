import { createHmac, timingSafeEqual } from "node:crypto";

const PROOF_VERSION = 1;
const SIGNING_CONTEXT = "hive:clone-terminal-proof:v1";
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const CLONE_TERMINAL_PROOF_TTL_MS = 5 * 60 * 1000;

export interface CloneTerminalProofClaims {
  workspaceId: string;
  agentId: string | null;
  sessionName: string;
  clonePath: string;
  expiresAt: number;
}

export interface CreateCloneTerminalProofOptions {
  workspaceId: string;
  agentId?: string | null;
  sessionName: string;
  clonePath: string;
  nowMs?: number;
  ttlMs?: number;
}

export interface VerifyCloneTerminalProofOptions {
  workspaceId: string;
  agentId?: string | null;
  sessionName: string;
  clonePath: string;
  nowMs?: number;
}

export type CloneTerminalProofFailureReason =
  | "missing"
  | "malformed"
  | "invalid_signature"
  | "expired"
  | "mismatch";

export type VerifyCloneTerminalProofResult =
  | { ok: true; claims: CloneTerminalProofClaims }
  | { ok: false; reason: CloneTerminalProofFailureReason };

interface SerializedCloneTerminalProofClaims extends CloneTerminalProofClaims {
  v: typeof PROOF_VERSION;
}

export function createCloneTerminalProof(
  options: CreateCloneTerminalProofOptions,
  secret: string,
): string {
  const signingSecret = normalizeSecret(secret);
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? CLONE_TERMINAL_PROOF_TTL_MS;
  const expiresAt = Math.floor(nowMs + ttlMs);
  const claims = normalizeClaims({
    workspaceId: options.workspaceId,
    agentId: options.agentId ?? null,
    sessionName: options.sessionName,
    clonePath: options.clonePath,
    expiresAt,
  });
  const payload = encodePayload({ v: PROOF_VERSION, ...claims });
  const signature = signPayload(payload, signingSecret);

  return `${payload}.${signature}`;
}

export function verifyCloneTerminalProof(
  proof: string | null | undefined,
  expected: VerifyCloneTerminalProofOptions,
  secret: string,
): VerifyCloneTerminalProofResult {
  if (!proof) {
    return { ok: false, reason: "missing" };
  }

  const signingSecret = normalizeSecret(secret);
  const parts = proof.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }

  const [payload, providedSignature] = parts;
  if (!isBase64UrlSegment(payload) || !isBase64UrlSegment(providedSignature)) {
    return { ok: false, reason: "malformed" };
  }

  const expectedSignature = signPayload(payload, signingSecret);
  if (!safeEqualBase64Url(expectedSignature, providedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const claims = decodePayload(payload);
  if (!claims) {
    return { ok: false, reason: "malformed" };
  }

  const nowMs = expected.nowMs ?? Date.now();
  if (claims.expiresAt <= nowMs) {
    return { ok: false, reason: "expired" };
  }

  const expectedAgentId = expected.agentId ?? null;
  const agentMatches = claims.agentId === null || claims.agentId === expectedAgentId;
  if (
    claims.workspaceId !== expected.workspaceId ||
    !agentMatches ||
    claims.sessionName !== expected.sessionName ||
    claims.clonePath !== expected.clonePath
  ) {
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true, claims };
}

function normalizeSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) {
    throw new Error("Clone terminal proof secret is required");
  }
  return normalized;
}

function normalizeClaims(claims: CloneTerminalProofClaims): CloneTerminalProofClaims {
  const normalized = {
    workspaceId: claims.workspaceId.trim(),
    agentId: claims.agentId?.trim() || null,
    sessionName: claims.sessionName.trim(),
    clonePath: claims.clonePath.trim(),
    expiresAt: claims.expiresAt,
  };

  if (
    !normalized.workspaceId ||
    !normalized.sessionName ||
    !normalized.clonePath ||
    !Number.isFinite(normalized.expiresAt)
  ) {
    throw new Error("Clone terminal proof claims are incomplete");
  }

  return normalized;
}

function encodePayload(payload: SerializedCloneTerminalProofClaims): string {
  const canonicalPayload = JSON.stringify({
    v: payload.v,
    workspaceId: payload.workspaceId,
    agentId: payload.agentId,
    sessionName: payload.sessionName,
    clonePath: payload.clonePath,
    expiresAt: payload.expiresAt,
  });
  return Buffer.from(canonicalPayload, "utf8").toString("base64url");
}

function decodePayload(payload: string): CloneTerminalProofClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as Partial<SerializedCloneTerminalProofClaims>;
  if (
    candidate.v !== PROOF_VERSION ||
    typeof candidate.workspaceId !== "string" ||
    !(typeof candidate.agentId === "string" || candidate.agentId === null) ||
    typeof candidate.sessionName !== "string" ||
    typeof candidate.clonePath !== "string" ||
    typeof candidate.expiresAt !== "number"
  ) {
    return null;
  }

  try {
    return normalizeClaims({
      workspaceId: candidate.workspaceId,
      agentId: candidate.agentId,
      sessionName: candidate.sessionName,
      clonePath: candidate.clonePath,
      expiresAt: candidate.expiresAt,
    });
  } catch {
    return null;
  }
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(SIGNING_CONTEXT)
    .update("\n")
    .update(payload)
    .digest("base64url");
}

function safeEqualBase64Url(expected: string, provided: string): boolean {
  try {
    const expectedBuffer = Buffer.from(expected, "base64url");
    const providedBuffer = Buffer.from(provided, "base64url");
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, providedBuffer);
  } catch {
    return false;
  }
}

function isBase64UrlSegment(value: string): boolean {
  return value.length > 0 && BASE64URL_RE.test(value);
}
