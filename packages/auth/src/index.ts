export { AuthServiceClient } from "./client.js";
export { signCookie, verifyCookie } from "./cookie.js";
export { encrypt, decrypt, tryDecrypt, validateEncryptionKey } from "./encryption.js";
export { checkRateLimit } from "./rate-limit.js";
export {
  TOKEN_LIFETIME_SECONDS,
  TOKEN_EXPIRY_WARNING_HOURS,
  SESSION_MAX_AGE_DAYS,
  SESSION_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  ENCRYPTION_ALGORITHM,
  IV_LENGTH,
  HEX_64_RE,
} from "./constants.js";
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
} from "./types.js";
