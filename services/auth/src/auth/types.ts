import type { IncomingMessage, ServerResponse } from "node:http";

// --- Token decryption ---

export interface DecryptedTokenResult {
  token: string;
  expiresAt: Date | null;
}

// --- Coder API ---

export interface ValidateInstanceResult {
  valid: boolean;
  version?: string;
  reason?: string;
}

export interface CoderLoginResult {
  sessionToken: string;
  userId: string;
  username: string;
}

export interface CoderLoginRequest {
  email: string;
  password: string;
}

export interface CoderLoginResponse {
  session_token: string;
}

export interface CoderUserResponse {
  id: string;
  username: string;
  email: string;
}

export interface BuildInfoResponse {
  version: string;
  external_url: string;
}

export interface CreateApiKeyRequest {
  lifetime_seconds?: number;
}

export interface CreateApiKeyResponse {
  key: string;
}

// --- Login orchestration ---

export interface LoginResult {
  sessionId: string;
  user: {
    id: string;
    username: string;
    email: string;
    coderUrl: string;
  };
}

// --- Router ---

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

export interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}
