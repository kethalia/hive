import { authServiceHeaders } from "./service-auth";
import type {
  CoderTokenResponse,
  CredentialResponse,
  LoginRequest,
  LoginResponse,
  SessionPayload,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

export class AuthServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export interface AuthServiceTransport {
  fetch?: typeof fetch;
  serviceSecret?: string;
  loginTimeoutMs?: number;
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

  private async request(
    path: string,
    init: RequestInit,
    signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(init.signal ? [init.signal] : []),
    ]),
  ): Promise<Response> {
    signal.throwIfAborted();
    const response = await (this.transport.fetch ?? fetch)(`${this.baseUrl}${path}`, {
      ...init,
      signal,
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

  async login(
    req: LoginRequest,
    clientIp?: string,
    callerSignal?: AbortSignal,
  ): Promise<LoginResponse> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.transport.loginTimeoutMs ?? this.timeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const res = await this.request(
      "/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authServiceHeaders(this.transport.serviceSecret),
          ...(clientIp ? { "X-Hive-Client-IP": clientIp } : {}),
        },
        body: JSON.stringify(req),
      },
      signal,
    );

    let body: unknown;
    try {
      body = await this.readLoginBody(res, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (res.ok) throw error;
      body = {};
    }
    if (!res.ok) {
      const message = (body as Record<string, unknown>)?.error;
      throw new AuthServiceError(
        typeof message === "string" ? message : `Login failed with status ${res.status}`,
        res.status,
      );
    }
    return body as LoginResponse;
  }

  private async readLoginBody(response: Response, signal: AbortSignal): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) {
      signal.throwIfAborted();
      return response.json();
    }
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
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
    await res.body?.cancel().catch(() => {});
  }

  async getSession(sessionId: string): Promise<SessionPayload | null> {
    const res = await this.request(`/sessions/${sessionId}`, {
      headers: authServiceHeaders(this.transport.serviceSecret),
    });

    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
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
      await res.body?.cancel().catch(() => {});
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
      await res.body?.cancel().catch(() => {});
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
