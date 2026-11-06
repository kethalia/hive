import type { CoderOAuthConfig } from "@hive/auth";
import { boundedCoderJson } from "./bounded-coder-json";

export class CoderOAuthError extends Error {
  constructor(
    readonly code:
      | "coder_oauth_unavailable"
      | "coder_oauth_reconnect"
      | "coder_oauth_flow_invalid"
      | "coder_oauth_refresh_pending",
    readonly refreshNotConsumed = false,
    readonly credentialRejected = false,
  ) {
    super(code);
  }
}
const fail = () => new CoderOAuthError("coder_oauth_unavailable");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
};
const string = (value: unknown, max: number) => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw fail();
  return value;
};
export async function oauthAwait<T>(work: Promise<T>, signal: AbortSignal) {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new CoderOAuthError("coder_oauth_unavailable"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
async function json(
  config: CoderOAuthConfig,
  path: string,
  init: RequestInit,
  send: typeof fetch,
  parent?: AbortSignal,
  timeoutMs = 5000,
) {
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(parent ? [parent] : [])]);
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    const pending = send(config.coderOrigin + path, {
      ...init,
      signal,
      redirect: "manual",
      credentials: "omit",
    });
    void pending.then(
      (late) => {
        if (signal.aborted && late.body && !late.body.locked)
          void late.body.cancel().catch(() => {});
      },
      () => {},
    );
    response = await oauthAwait(pending, signal);
    signal.throwIfAborted();
    if (!response.ok || response.redirected) {
      // Resource authorization and client configuration failures do not prove
      // that this user's grant was revoked. Only these endpoint-specific
      // failures establish that the captured credential needs reconnecting.
      if (path === "/api/v2/users/me" && response.status === 401 && !response.redirected)
        throw new CoderOAuthError("coder_oauth_reconnect", false, true);
      if (
        path === "/oauth2/tokens" &&
        [400, 401, 403].includes(response.status) &&
        !response.redirected
      ) {
        const failure = object(await boundedCoderJson(response, signal));
        signal.throwIfAborted();
        if (response.status === 400 && failure.error === "invalid_grant")
          throw new CoderOAuthError("coder_oauth_reconnect", false, true);
        // Client authentication precedes grant redemption. A structured client
        // refusal proves no rotating grant was consumed; transport failures do not.
        if (failure.error === "invalid_client")
          throw new CoderOAuthError("coder_oauth_unavailable", true);
      }
      throw fail();
    }
    const value = object(await boundedCoderJson(response, signal));
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (error instanceof CoderOAuthError) throw error;
    throw fail();
  } finally {
    if (response?.body && !response.body.locked)
      await Promise.race([
        response.body.cancel().catch(() => {}),
        new Promise((done) => setTimeout(done, 100)),
      ]);
  }
}
export async function coderOAuthApplicationsHost(
  config: CoderOAuthConfig,
  token: string,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  try {
    const value = await json(
      config,
      "/api/v2/applications/host",
      { headers: { Authorization: `Bearer ${token}` } },
      send,
      signal,
      1500,
    );
    if (
      typeof value.host !== "string" ||
      value.host.length > 512 ||
      value.host.split("*").length !== 2
    )
      return "";
    const url = new URL(`https://${value.host.replace("*", "hive-workspace")}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port)
      return "";
    return value.host;
  } catch {
    return "";
  }
}
export async function verifyCoderOAuthDiscovery(
  config: CoderOAuthConfig,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const data = await json(config, "/.well-known/oauth-authorization-server", {}, send, signal);
  if (
    data.issuer !== config.coderOrigin ||
    data.authorization_endpoint !== `${config.coderOrigin}/oauth2/authorize` ||
    data.token_endpoint !== `${config.coderOrigin}/oauth2/tokens` ||
    !Array.isArray(data.code_challenge_methods_supported) ||
    !data.code_challenge_methods_supported.includes("S256") ||
    !Array.isArray(data.token_endpoint_auth_methods_supported) ||
    !data.token_endpoint_auth_methods_supported.includes("client_secret_basic") ||
    !Array.isArray(data.response_types_supported) ||
    !data.response_types_supported.includes("code")
  )
    throw fail();
}
export async function exchangeCoderOAuth(
  config: CoderOAuthConfig,
  parameters: Record<string, string>,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const value = await json(
    config,
    "/oauth2/tokens",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`,
      },
      body: new URLSearchParams(parameters).toString(),
    },
    send,
    signal,
  );
  const accessToken = string(value.access_token, 4096);
  if (
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    !Number.isSafeInteger(value.expires_in) ||
    Number(value.expires_in) < 1 ||
    Number(value.expires_in) > 366 * 86400 ||
    (value.scope !== undefined &&
      (typeof value.scope !== "string" || !value.scope.split(" ").includes("coder:all")))
  )
    throw fail();
  const refreshToken =
    value.refresh_token === undefined ? undefined : string(value.refresh_token, 4096);
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + Number(value.expires_in) * 1000),
  };
}
export async function verifyCoderOAuthIdentity(
  config: CoderOAuthConfig,
  accessToken: string,
  send: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const value = await json(
    config,
    "/api/v2/users/me",
    { headers: { Authorization: `Bearer ${accessToken}` } },
    send,
    signal,
  );
  const id = string(value.id, 36),
    username = string(value.username, 128),
    email = string(value.email, 320);
  if (typeof value.status !== "string") throw fail();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ||
    !email.includes("@") ||
    value.status !== "active" ||
    value.deleted === true
  )
    throw new CoderOAuthError("coder_oauth_reconnect", false, true);
  return { id, username, email };
}

/** RFC7009 acknowledgement is not proof a token existed. Coder deletes this
 * exact API-key-backed access/refresh pair; never use the broad user/app route. */
export async function revokeCoderOAuthAccess(
  config: CoderOAuthConfig,
  accessToken: string,
  send: typeof fetch = fetch,
): Promise<boolean> {
  const signal = AbortSignal.timeout(5000);
  let response: Response | undefined;
  try {
    const pending = send(`${config.coderOrigin}/oauth2/revoke`, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString(),
    });
    void pending.then(
      (late) => {
        if (signal.aborted && late.body && !late.body.locked)
          void late.body.cancel().catch(() => {});
      },
      () => {},
    );
    response = await oauthAwait(pending, signal);
    signal.throwIfAborted();
    return response.status === 200 && !response.redirected;
  } catch {
    return false;
  } finally {
    if (response?.body && !response.body.locked)
      await Promise.race([
        response.body.cancel().catch(() => {}),
        new Promise((done) => setTimeout(done, 100)),
      ]);
  }
}
