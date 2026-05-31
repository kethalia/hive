export { AuthServiceClient } from "./client";
export type {
  CloneTerminalProofClaims,
  CloneTerminalProofFailureReason,
  CreateCloneTerminalProofOptions,
  VerifyCloneTerminalProofOptions,
  VerifyCloneTerminalProofResult,
} from "./clone-terminal-proof";
export {
  CLONE_TERMINAL_PROOF_TTL_MS,
  createCloneTerminalProof,
  verifyCloneTerminalProof,
} from "./clone-terminal-proof";
export {
  ENCRYPTION_ALGORITHM,
  HEX_64_RE,
  IV_LENGTH,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_DAYS,
  SESSION_MAX_AGE_SECONDS,
  TOKEN_EXPIRY_WARNING_HOURS,
  TOKEN_LIFETIME_SECONDS,
} from "./constants";
export { signCookie, verifyCookie } from "./cookie";
export { decrypt, encrypt, tryDecrypt, validateEncryptionKey } from "./encryption";
export { checkRateLimit } from "./rate-limit";
export type {
  CoderTokenResponse,
  CredentialResponse,
  DecryptResult,
  EncryptedData,
  LoginRequest,
  LoginResponse,
  RateLimitResult,
  SessionData,
  SessionPayload,
  TokenStatus,
  TokenStatusResult,
} from "./types";
