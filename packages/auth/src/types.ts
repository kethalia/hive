// --- Token status ---

export type TokenStatus =
  | "valid"
  | "expiring"
  | "expired"
  | "key_mismatch"
  | "decrypt_failed";

// --- Encryption ---

export interface EncryptedData {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

export type DecryptResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: "key_mismatch" | "other"; error: Error };

// --- Rate limiting ---

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

// --- Sessions ---

export interface SessionPayload {
  userId: string;
  coderUserId: string;
  username: string;
  email: string;
  coderUrl: string;
  sessionId: string;
  expiresAt: string;
}

export interface SessionData {
  user: {
    id: string;
    coderUrl: string;
    coderUserId: string;
    username: string;
    email: string;
  };
  session: {
    id: string;
    sessionId: string;
    expiresAt: Date;
  };
}

// --- Token status results ---

export interface TokenStatusResult {
  status: TokenStatus;
  expiresAt: Date | null;
}

// --- API types ---

export interface CredentialResponse {
  status: TokenStatus;
  expiresAt: string | null;
}

export interface LoginRequest {
  coderUrl: string;
  email: string;
  password: string;
}

export interface LoginResponse {
  sessionId: string;
  user: {
    id: string;
    username: string;
    email: string;
    coderUrl: string;
  };
}

export interface CoderTokenResponse {
  token: string;
  coderUrl: string;
  expiresAt: string | null;
}
