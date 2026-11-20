import { SESSION_MAX_AGE_SECONDS } from "@hive/auth";
import { getDb } from "@hive/db";
import {
  CODER_OAUTH_POPUP_MESSAGE,
  validCoderOAuthPopupAttempt,
} from "@/lib/auth/coder-oauth-popup";
import { coderOAuthPopupCss, coderOAuthPopupPanel } from "@/lib/auth/coder-oauth-popup-view";
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
import { registerCoderPreviewCallback } from "../../../services/auth/src/auth/coder-preview-callback";
import { appendClearSessionCookieHeaders } from "./session-cookie";

const allowed = new Map([
  ["/api/auth/sign-in/social", "POST"],
  ["/api/auth/callback/coder", "GET"],
  ["/api/auth/sign-out", "POST"],
]);

function popupCompletionHtml(attempt: string, origin: string, success: boolean): string {
  const message = JSON.stringify({ type: CODER_OAUTH_POPUP_MESSAGE, attempt, success }).replace(
    /</g,
    "\\u003c",
  );
  const targetOrigin = JSON.stringify(origin).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>Coder sign-in · Hive</title>
    <style>${coderOAuthPopupCss}</style>
  </head>
  <body style="margin: 0">
    <main class="coder-oauth-popup">${coderOAuthPopupPanel(success ? "finishing" : "failed")}</main>
    <script>
      if (window.opener) {
        window.opener.postMessage(${message}, ${targetOrigin});
      }
    </script>
  </body>
</html>`;
}

/** Public auth exposes the Coder sign-in flow and local sign-out only. */
export async function handleCoderAuth(request: Request) {
  const url = new URL(request.url);
  if (!coderOAuthEnabled() || allowed.get(url.pathname) !== request.method)
    return Response.json({ error: "Not found" }, { status: 404 });
  const privateHeaders = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  const unavailable = (code: string) =>
    Response.json(
      { error: "Coder sign-in is temporarily unavailable", code },
      { status: 503, headers: privateHeaders },
    );
  let config: ReturnType<typeof getCoderOAuthConfig>;
  try {
    config = getCoderOAuthConfig();
  } catch {
    return unavailable("coder_oauth_configuration");
  }
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
        if (Object.hasOwn(body, "popup") && !validCoderOAuthPopupAttempt(body.popup))
          throw Error("popup");
        let callbackURL = "/workspaces";
        let errorCallbackURL = "/login";
        if (validCoderOAuthPopupAttempt(body.popup)) {
          const completion = new URL("/login/complete", config.publicOrigin);
          completion.searchParams.set("attempt", body.popup);
          callbackURL = `${completion.pathname}${completion.search}`;
          completion.searchParams.set("error", "1");
          errorCallbackURL = `${completion.pathname}${completion.search}`;
        }
        request = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          signal,
          body: JSON.stringify({
            provider: "coder",
            callbackURL,
            errorCallbackURL,
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
  const db = getDb();
  if (request.method === "POST" && url.pathname.endsWith("/social")) {
    try {
      await registerCoderPreviewCallback(config, db, signal);
    } catch (error) {
      const known =
        error instanceof Error &&
        /^coder_preview_callback_(?:configuration|metadata|(?:database|read|update)(?:_[1-5][0-9]{2}|_P[0-9]{4})?)$/.test(
          error.message,
        );
      return unavailable(known ? error.message : "coder_preview_callback_unavailable");
    }
  }
  const auth = createCoderAuth(db, { signal });
  const response = await auth.handler(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(privateHeaders)) headers.set(name, value);
  const callback = url.pathname === "/api/auth/callback/coder";
  const redirect = response.status >= 300 && response.status < 400;
  const location = headers.get("Location");
  const destination =
    callback && redirect && location ? new URL(location, config.publicOrigin) : null;
  const candidateAttempt =
    destination?.origin === config.publicOrigin &&
    destination.pathname === "/login/complete" &&
    destination.searchParams.getAll("attempt").length === 1
      ? destination.searchParams.get("attempt")
      : null;
  const popupAttempt = validCoderOAuthPopupAttempt(candidateAttempt) ? candidateAttempt : null;
  const successfulCallback =
    destination?.origin === config.publicOrigin &&
    (destination.pathname === "/workspaces" ||
      (popupAttempt !== null && !destination.searchParams.has("error")));
  let verifiedSession = false;
  if (successfulCallback) {
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
        verifiedSession = true;
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
  if (popupAttempt !== null) {
    headers.delete("Location");
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");
    headers.set("Content-Type", "text/html; charset=utf-8");
    await response.body?.cancel().catch(() => {});
    return new Response(
      popupCompletionHtml(popupAttempt, config.publicOrigin, successfulCallback && verifiedSession),
      { status: 200, headers },
    );
  }
  let body: BodyInit | null = response.body;
  if (callback && (redirect || !headers.get("Content-Type"))) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    if (!redirect && !body && response.status !== 204 && response.status !== 205)
      body = "Coder sign-in could not be completed. Return to Hive and try again.";
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
