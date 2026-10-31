import { authServiceHeaders } from "./service-auth";
import type {
  CoderTokenResponse,
  CredentialResponse,
  LoginRequest,
  LoginResponse,
  SessionPayload,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AuthServiceTransport {
  fetch?: typeof fetch;
  serviceSecret?: string;
}

export class AuthServiceClient {
  private baseUrl: string;
  private timeoutMs: number;
  private transport: AuthServiceTransport;

  constructor(
    baseUrl: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    transport: AuthServiceTransport = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.transport = transport;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await (this.transport.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
      // Workers does not implement redirect:"error". Manual also prevents the
      // service credential/password from being forwarded to a redirect target.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Auth service redirects are not allowed");
    }
    return response;
  }

  async login(req: LoginRequest, clientIp?: string): Promise<LoginResponse> {
    const res = await this.request("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authServiceHeaders(this.transport.serviceSecret),
        ...(clientIp ? { "X-Hive-Client-IP": clientIp } : {}),
      },
      body: JSON.stringify(req),
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
    const res = await this.request("/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authServiceHeaders(this.transport.serviceSecret),
      },
      body: JSON.stringify({ sessionId }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error ?? `Logout failed with status ${res.status}`,
      );
    }
  }

  async getSession(sessionId: string): Promise<SessionPayload | null> {
    const res = await this.request(`/sessions/${sessionId}`, {
      headers: authServiceHeaders(this.transport.serviceSecret),
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
    const res = await this.request(`/sessions/${sessionId}/credentials`, {
      headers: authServiceHeaders(this.transport.serviceSecret),
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
    const res = await this.request(`/sessions/${sessionId}/token`, {
      headers: authServiceHeaders(this.transport.serviceSecret),
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
