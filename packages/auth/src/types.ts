export type TokenStatus =
  | "valid"
  | "expiring"
  | "expired"
  | "key_mismatch"
  | "decrypt_failed";

export interface SessionPayload {
  userId: string;
  username: string;
  email: string;
  coderUrl: string;
  sessionId: string;
  expiresAt: Date;
}

export interface CredentialResponse {
  status: TokenStatus;
  expiresAt: Date | null;
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
  expiresAt: Date | null;
}
