import {
  CODER_OAUTH_FLOW_COOKIE,
  getCoderOAuthConfig,
  isConfiguredCoderUrl,
  SESSION_MAX_AGE_SECONDS,
} from "@hive/auth";
import {
  CODER_HOST_COOKIE,
  coderFrameConfiguredUrls,
} from "@/lib/security/content-security-policy";
import { getClientIp } from "./login";
import { loginRateLimiter } from "./rate-limit";
import { getAuthServiceClient } from "./service-client";
import { createSignedSessionCookie } from "./session";
import { appendSetSessionCookieHeaders } from "./session-cookie";

const secureHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const clearFlow = (headers: Headers) =>
  headers.append(
    "Set-Cookie",
    `${CODER_OAUTH_FLOW_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
const unavailable = () =>
  new Response("Coder sign-in is unavailable.", { status: 503, headers: secureHeaders });
export async function coderOAuthStart(request: Request): Promise<Response> {
  let config: ReturnType<typeof getCoderOAuthConfig>;
  try {
    config = getCoderOAuthConfig();
  } catch {
    return unavailable();
  }
  if (!config) return new Response(null, { status: 404, headers: secureHeaders });
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== config.publicOrigin ||
    url.search ||
    url.hash ||
    (request.headers.has("origin") && request.headers.get("origin") !== config.publicOrigin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return new Response(null, { status: 400, headers: secureHeaders });
  const ip =
    process.env.HIVE_RUNTIME_TARGET === "cloudflare"
      ? (request.headers.get("CF-Connecting-IP") ?? "unknown")
      : getClientIp(request.headers);
  if (!loginRateLimiter.check(ip).allowed)
    return new Response("Please wait before signing in again.", {
      status: 429,
      headers: secureHeaders,
    });
  try {
    const started = await getAuthServiceClient().startCoderOAuth(ip, request.signal);
    const target = new URL(started.authorizationUrl);
    if (
      target.origin !== config.coderOrigin ||
      target.pathname !== "/oauth2/authorize" ||
      target.username ||
      target.password ||
      target.hash ||
      target.searchParams.get("client_id") !== config.clientId ||
      target.searchParams.get("redirect_uri") !== config.callbackUrl ||
      target.searchParams.get("code_challenge_method") !== "S256" ||
      target.searchParams.has("code_verifier") ||
      target.searchParams.has("client_secret") ||
      !/^[A-Za-z0-9_-]{43}$/.test(started.browserSecret) ||
      started.expiresIn !== 600
    )
      throw new Error("coder_oauth_failed");
    const headers = new Headers({ ...secureHeaders, Location: target.href });
    headers.append(
      "Set-Cookie",
      `${CODER_OAUTH_FLOW_COOKIE}=${started.browserSecret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
    return new Response(null, { status: 303, headers });
  } catch {
    return new Response(null, {
      status: 303,
      headers: {
        ...secureHeaders,
        Location: `${config.publicOrigin}/login?error=coder_oauth_failed`,
      },
    });
  }
}
export async function coderOAuthCallback(request: Request): Promise<Response> {
  let config: ReturnType<typeof getCoderOAuthConfig>;
  try {
    config = getCoderOAuthConfig();
  } catch {
    const response = unavailable();
    clearFlow(response.headers);
    return response;
  }
  if (!config) return new Response(null, { status: 404, headers: secureHeaders });
  const headers = new Headers({
    ...secureHeaders,
    Location: `${config.publicOrigin}/login?error=coder_oauth_failed`,
  });
  clearFlow(headers);
  try {
    const url = new URL(request.url),
      cookies = (request.headers.get("cookie") ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${CODER_OAUTH_FLOW_COOKIE}=`))
        .map((part) => part.slice(CODER_OAUTH_FLOW_COOKIE.length + 1));
    if (
      request.method !== "GET" ||
      url.origin !== config.publicOrigin ||
      url.hash ||
      request.url.length > 8192 ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length > 1 ||
      url.searchParams.getAll("error").length > 1 ||
      cookies.length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(cookies[0]) ||
      [...url.searchParams.keys()].some(
        (key) => !["state", "code", "error", "error_description", "error_uri", "iss"].includes(key),
      )
    )
      throw new Error("coder_oauth_failed");
    const state = url.searchParams.get("state") ?? "",
      code = url.searchParams.get("code") ?? undefined;
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      (url.searchParams.has("iss") && url.searchParams.get("iss") !== config.coderOrigin)
    )
      throw new Error("coder_oauth_failed");
    const result = await getAuthServiceClient().completeCoderOAuth(
      { state, browserSecret: cookies[0], code, denied: url.searchParams.has("error") },
      request.signal,
    );
    if (!isConfiguredCoderUrl(result.user.coderUrl) || !/^[a-f0-9-]{36}$/i.test(result.sessionId))
      throw new Error("coder_oauth_failed");
    headers.set("Location", `${config.publicOrigin}/workspaces`);
    appendSetSessionCookieHeaders(
      headers,
      createSignedSessionCookie(result.sessionId),
      url.hostname,
    );
    const coderFrames = coderFrameConfiguredUrls(config.coderOrigin, result.applicationsHost).join(
      "~",
    );
    headers.append(
      "Set-Cookie",
      `${CODER_HOST_COOKIE}=${encodeURIComponent(coderFrames)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
  } catch {
    /* No callback parameter, provider response or credential reaches errors/logs. */
  }
  return new Response(null, { status: 303, headers });
}
