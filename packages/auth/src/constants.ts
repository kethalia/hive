export const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export const TOKEN_EXPIRY_WARNING_HOURS = 48;

export const SESSION_MAX_AGE_DAYS = 30;

export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

export const ENCRYPTION_ALGORITHM = "aes-256-gcm";

export const IV_LENGTH = 12;

export const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

export const SESSION_COOKIE_NAME = "hive-session";
