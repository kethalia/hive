import { SESSION_MAX_AGE_SECONDS } from "@hive/auth";
import { getDb } from "@hive/db";
import {
  CODER_HOST_COOKIE,
  coderFrameConfiguredUrls,
} from "@/lib/security/content-security-policy";
import { terminalBody } from "@/lib/terminal/transport-io";
import { createCoderAuth } from "../../../services/auth/src/auth/better-auth";
import { fetchCoderApi } from "../../../services/auth/src/auth/coder-fetch";
import {
  coderAuthCookieValues,
  coderOAuthEnabled,
  getCoderOAuthConfig,
} from "../../../services/auth/src/auth/coder-oauth-config";
import { getUsableCoderCredential } from "../../../services/auth/src/auth/coder-oauth-credentials";
import { coderOAuthApplicationsHost } from "../../../services/auth/src/auth/coder-oauth-provider";
import { appendClearSessionCookieHeaders } from "./session-cookie";

const allowed = new Map([
  ["/api/auth/sign-in/social", "POST"],
  ["/api/auth/callback/coder", "GET"],
  ["/api/auth/sign-out", "POST"],
]);

/** Public auth exposes the Coder sign-in flow and local sign-out only. */
export async function handleCoderAuth(request: Request) {
  const url = new URL(request.url);
  if (!coderOAuthEnabled() || allowed.get(url.pathname) !== request.method)
    return Response.json({ error: "Not found" }, { status: 404 });
  const config = getCoderOAuthConfig();
  const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  if (
    url.origin !== config.publicOrigin ||
    (request.method === "POST" &&
      (request.headers.get("Origin") !== config.publicOrigin ||
        request.headers.get("Sec-Fetch-Site") === "cross-site"))
  )
    return Response.json({ error: "Origin rejected" }, { status: 403, headers: privateHeaders });
  if (coderAuthCookieValues(request.headers.get("Cookie")).length > 1)
    return Response.json({ error: "Sign in again" }, { status: 401, headers: privateHeaders });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  if (request.method === "POST") {
    try {
      const bytes = request.body
        ? await terminalBody(new Response(request.body), 4096, signal)
        : new Uint8Array();
      const body = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
      if (url.pathname.endsWith("/social")) {
        if (body.provider !== "coder") throw Error("provider");
        request = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          signal,
          body: JSON.stringify({
            provider: "coder",
            callbackURL: "/workspaces",
            errorCallbackURL: "/login",
            disableRedirect: true,
          }),
        });
      } else
        request = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          signal,
          body: "{}",
        });
    } catch {
      return Response.json(
        { error: "Invalid authentication request" },
        { status: 400, headers: privateHeaders },
      );
    }
  }
  const auth = createCoderAuth(getDb(), { signal });
  const response = await auth.handler(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(privateHeaders)) headers.set(name, value);
  if (
    url.pathname === "/api/auth/callback/coder" &&
    response.status >= 300 &&
    response.status < 400 &&
    new URL(headers.get("Location") ?? "/login", config.publicOrigin).pathname === "/workspaces"
  ) {
    appendClearSessionCookieHeaders(headers, url.hostname);
    let host = "";
    try {
      const browserCookies = headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
      const active = await auth.api.getSession({
        headers: new Headers({ Cookie: browserCookies }),
      });
      if (active) {
        const credential = await getUsableCoderCredential(active.user.id, { signal });
        host = await coderOAuthApplicationsHost(config, credential.token, fetchCoderApi, signal);
      }
    } catch {
      /* Preserve the committed authentication response during ancillary discovery failures. */
    }
    const sources = coderFrameConfiguredUrls(config.coderOrigin, host).join("~");
    headers.append(
      "Set-Cookie",
      `${CODER_HOST_COOKIE}=${encodeURIComponent(sources)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${config.publicOrigin.startsWith("https://") ? "; Secure" : ""}`,
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
