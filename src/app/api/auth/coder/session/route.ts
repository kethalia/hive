import { getRequestSession } from "@/lib/auth/session";

const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Observes the current browser session without exposing its public UUID or credentials. */
export async function GET(request: Request) {
  if (process.env.HIVE_CODER_OAUTH_ENABLED !== "true")
    return Response.json({ error: "Not found" }, { status: 404, headers });
  const origin = process.env.HIVE_PUBLIC_ORIGIN;
  const suppliedOrigin = request.headers.get("Origin");
  if (
    new URL(request.url).origin !== origin ||
    (suppliedOrigin !== null && suppliedOrigin !== origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return Response.json({ error: "Origin rejected" }, { status: 403, headers });

  const session = await getRequestSession();
  if (!session) return Response.json({ session: null }, { headers });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(session.session.sessionId),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return Response.json({ session: fingerprint }, { headers });
}
