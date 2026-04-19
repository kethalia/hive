export const CODER_API_TIMEOUT_MS = 10_000;

export const API_KEY_CREATION_RETRIES = 3;

export const RATE_LIMIT_MAX_ATTEMPTS = 5;

export const RATE_LIMIT_WINDOW_MS = 60_000;

export const SESSION_TOKEN_FALLBACK_EXPIRY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_PORT = 4400;

export const CODER_SESSION_TOKEN_HEADER = "Coder-Session-Token";

export const CODER_API_PATHS = {
  BUILD_INFO: "/api/v2/buildinfo",
  LOGIN: "/api/v2/users/login",
  ME: "/api/v2/users/me",
  USER_KEYS: (userId: string) => `/api/v2/users/${userId}/keys`,
} as const;

export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  CODER_UNREACHABLE: "CODER_UNREACHABLE",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  TOKEN_NOT_FOUND: "TOKEN_NOT_FOUND",
  KEY_UNAVAILABLE: "KEY_UNAVAILABLE",
  KEY_MISMATCH: "KEY_MISMATCH",
  DECRYPT_FAILED: "DECRYPT_FAILED",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
