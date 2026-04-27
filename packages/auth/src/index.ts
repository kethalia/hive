export { AuthServiceClient } from "./client";
export { signCookie, verifyCookie } from "./cookie";
export { encrypt, decrypt, tryDecrypt, validateEncryptionKey } from "./encryption";
export { checkRateLimit } from "./rate-limit";
export {
  TOKEN_LIFETIME_SECONDS,
  TOKEN_EXPIRY_WARNING_HOURS,
  SESSION_MAX_AGE_DAYS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  ENCRYPTION_ALGORITHM,
  IV_LENGTH,
  HEX_64_RE,
} from "./constants";
export type {
  TokenStatus,
  EncryptedData,
  DecryptResult,
  RateLimitResult,
  SessionPayload,
  SessionData,
  TokenStatusResult,
  CredentialResponse,
  CoderTokenResponse,
  LoginRequest,
  LoginResponse,
} from "./types";
