import {
  CODER_API_TIMEOUT_MS,
  CODER_SESSION_TOKEN_HEADER,
  CODER_API_PATHS,
} from "./constants.js";
import type {
  ValidateInstanceResult,
  CoderLoginResult,
  CoderLoginRequest,
  CoderLoginResponse,
  CoderUserResponse,
  BuildInfoResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
} from "./types.js";

export type { ValidateInstanceResult, CoderLoginResult };

export async function validateCoderInstance(
  url: string
): Promise<ValidateInstanceResult> {
  const baseUrl = url.replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseUrl}${CODER_API_PATHS.BUILD_INFO}`, {
      signal: AbortSignal.timeout(CODER_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { valid: false, reason: "not a Coder instance" };
    }
    const data = (await res.json()) as BuildInfoResponse;
    if (!data.version) {
      return { valid: false, reason: "not a Coder instance" };
    }
    return { valid: true, version: data.version };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message.toLowerCase() : String(err);
    if (
      message.includes("getaddrinfo") ||
      message.includes("enotfound") ||
      message.includes("dns")
    ) {
      return { valid: false, reason: "DNS resolution failed" };
    }
    if (
      message.includes("timeout") ||
      message.includes("abort") ||
      message.includes("etimedout")
    ) {
      return { valid: false, reason: "connection timeout" };
    }
    return { valid: false, reason: "not a Coder instance" };
  }
}

export async function coderLogin(
  baseUrl: string,
  email: string,
  password: string
): Promise<CoderLoginResult> {
  const url = baseUrl.replace(/\/+$/, "");
  const body: CoderLoginRequest = { email, password };
  const res = await fetch(`${url}${CODER_API_PATHS.LOGIN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CODER_API_TIMEOUT_MS),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("invalid credentials");
    }
    const text = await res.text().catch(() => "");
    throw new Error(
      `login failed: ${res.status} ${res.statusText} — ${text}`
    );
  }

  const loginData = (await res.json()) as CoderLoginResponse;

  const meRes = await fetch(`${url}${CODER_API_PATHS.ME}`, {
    headers: {
      "Content-Type": "application/json",
      [CODER_SESSION_TOKEN_HEADER]: loginData.session_token,
    },
    signal: AbortSignal.timeout(CODER_API_TIMEOUT_MS),
  });

  if (!meRes.ok) {
    throw new Error("failed to fetch user info after login");
  }

  const user = (await meRes.json()) as CoderUserResponse;

  return {
    sessionToken: loginData.session_token,
    userId: user.id,
    username: user.username,
  };
}

export async function createCoderApiKey(
  baseUrl: string,
  sessionToken: string,
  userId: string,
  lifetimeSeconds?: number
): Promise<string | null> {
  const url = baseUrl.replace(/\/+$/, "");
  const body: CreateApiKeyRequest = lifetimeSeconds
    ? { lifetime_seconds: lifetimeSeconds }
    : {};
  try {
    const res = await fetch(`${url}${CODER_API_PATHS.USER_KEYS(userId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CODER_SESSION_TOKEN_HEADER]: sessionToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CODER_API_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.log(
        `[auth-service] API key creation failed: ${res.status} ${res.statusText}`
      );
      return null;
    }

    const data = (await res.json()) as CreateApiKeyResponse;
    return data.key;
  } catch (err) {
    console.log(
      `[auth-service] API key creation error: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
