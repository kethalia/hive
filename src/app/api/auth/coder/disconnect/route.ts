import { coderAuthCookieName } from "@hive/auth";
import { getRequestSession } from "@/lib/auth/session";
import { appendClearSessionCookieHeaders } from "@/lib/auth/session-cookie";
import { CODER_HOST_COOKIE } from "@/lib/security/content-security-policy";
import { disconnectCoderOAuth } from "../../../../../../services/auth/src/auth/coder-oauth-disconnect";

export async function POST(request: Request) {
  if (process.env.HIVE_CODER_OAUTH_ENABLED !== "true")
    return Response.json({ error: "Not found" }, { status: 404 });
  if (
    request.headers.get("Origin") !== process.env.HIVE_PUBLIC_ORIGIN ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return Response.json({ error: "Origin rejected" }, { status: 403 });
  const session = await getRequestSession();
  if (!session) return Response.json({ error: "Sign in required" }, { status: 401 });
  const revoked = await disconnectCoderOAuth(session.user.id);
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  headers.append(
    "Set-Cookie",
    `${coderAuthCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request.url.startsWith("https://") ? "; Secure" : ""}`,
  );
  appendClearSessionCookieHeaders(headers, new URL(request.url).hostname);
  headers.append(
    "Set-Cookie",
    `${CODER_HOST_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request.url.startsWith("https://") ? "; Secure" : ""}`,
  );
  return Response.json(
    revoked
      ? { success: true }
      : {
          error:
            "Hive is disconnected. Coder revocation could not be confirmed. Open Coder and revoke Hive authorization.",
        },
    { status: revoked ? 200 : 503, headers },
  );
}
