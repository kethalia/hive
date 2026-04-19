import type {
  LoginRequest,
  LoginResponse,
  SessionPayload,
  CredentialResponse,
  CoderTokenResponse,
} from "@hive/auth";

export class AuthServiceClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async login(req: LoginRequest): Promise<LoginResponse> {
    const res = await fetch(`${this.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ??
          `Login failed with status ${res.status}`,
      );
    }

    return (await res.json()) as LoginResponse;
  }

  async logout(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ??
          `Logout failed with status ${res.status}`,
      );
    }
  }

  async getSession(sessionId: string): Promise<SessionPayload | null> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}`);

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ??
          `Get session failed with status ${res.status}`,
      );
    }

    return (await res.json()) as SessionPayload;
  }

  async getCredentials(sessionId: string): Promise<CredentialResponse | null> {
    const res = await fetch(
      `${this.baseUrl}/sessions/${sessionId}/credentials`,
    );

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
    const res = await fetch(
      `${this.baseUrl}/sessions/${sessionId}/token`,
    );

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ??
          `Get token failed with status ${res.status}`,
      );
    }

    return (await res.json()) as CoderTokenResponse;
  }
}

let client: AuthServiceClient | null = null;

export function getAuthServiceClient(): AuthServiceClient {
  if (!client) {
    const baseUrl = process.env.AUTH_SERVICE_URL ?? "http://localhost:4400";
    client = new AuthServiceClient(baseUrl);
  }
  return client;
}
