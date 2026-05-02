import type {
  CoderTokenResponse,
  CredentialResponse,
  LoginRequest,
  LoginResponse,
  SessionPayload,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

export class AuthServiceClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  async login(req: LoginRequest): Promise<LoginResponse> {
    const res = await fetch(`${this.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ?? `Login failed with status ${res.status}`,
      );
    }

    return (await res.json()) as LoginResponse;
  }

  async logout(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ?? `Logout failed with status ${res.status}`,
      );
    }
  }

  async getSession(sessionId: string): Promise<SessionPayload | null> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ?? `Get session failed with status ${res.status}`,
      );
    }

    return (await res.json()) as SessionPayload;
  }

  async getCredentials(sessionId: string): Promise<CredentialResponse | null> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/credentials`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ??
          `Get credentials failed with status ${res.status}`,
      );
    }

    return (await res.json()) as CredentialResponse;
  }

  async getCoderToken(sessionId: string): Promise<CoderTokenResponse | null> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/token`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ?? `Get token failed with status ${res.status}`,
      );
    }

    return (await res.json()) as CoderTokenResponse;
  }
}
