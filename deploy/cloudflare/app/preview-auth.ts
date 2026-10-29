import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PREVIEW_COOKIE = "__Host-hive-preview";
const COOKIE_SECONDS = 15 * 60;
const key = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
type CookieOptions = { cookieSecret?: unknown; origin?: unknown; now?: number };
function configuredOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
function signature(payload: string, origin: string, secret: string) {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`hive-private-preview-v1\0${origin}\0${payload}`)
    .digest("base64url");
}
export function previewCookieExpiresAt(request: Request, options: CookieOptions): number | null {
  const origin = configuredOrigin(options.origin);
  if (!origin || new URL(request.url).origin !== origin || !key(options.cookieSecret)) return null;
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${PREVIEW_COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(PREVIEW_COOKIE.length + 1);
  const parts = /^v1\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(
    value,
  );
  if (!parts) return null;
  const now = Math.floor((options.now ?? Date.now()) / 1000),
    iat = Number(parts[1]),
    exp = Number(parts[2]);
  if (iat > now || exp <= now || exp <= iat || exp - iat > COOKIE_SECONDS) return null;
  const actual = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(
    signature(`v1.${parts[1]}.${parts[2]}.${parts[3]}`, origin, options.cookieSecret),
    "base64url",
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? exp * 1000 : null;
}

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization, Cookie",
};

/** Preview authority is runtime-only, independent of Hive sessions and Coder tokens. */
export function authorizePreview(
  request: Request,
  secret: unknown,
  cookies: CookieOptions = {},
): Response | null {
  if (!key(secret))
    return Response.json(
      { error: "Private preview is not configured." },
      { status: 503, headers: privateHeaders },
    );
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("Authorization") ?? "");
  if (
    (actual.length !== expected.length || !timingSafeEqual(actual, expected)) &&
    !previewCookieExpiresAt(request, cookies)
  )
    return Response.json(
      { error: "Private preview authorization required." },
      { status: 401, headers: privateHeaders },
    );
  return null;
}

/** Same-origin bearer-authenticated bootstrap; no redirect, query or body credential. */
export async function bootstrapPreview(
  request: Request,
  secret: unknown,
  options: CookieOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/__hive-preview/access") return null;
  const respond = (status: number) => new Response(null, { status, headers: privateHeaders });
  if (request.method !== "POST") return respond(405);
  if (!key(secret) || !key(options.cookieSecret)) return respond(503);
  const origin = configuredOrigin(options.origin);
  if (!origin) return respond(503);
  if (
    url.origin !== origin ||
    request.headers.get("Origin") !== origin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return respond(403);
  const unauthorized = authorizePreview(request, secret); // Cookie alone cannot renew authority.
  if (unauthorized) return unauthorized;
  if (url.search) return respond(400);
  // Workers can supply a non-null stream even for an empty network POST.
  // Read only bounded empty chunks; reject immediately on any body bytes.
  if (request.body) {
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let empty = false;
    try {
      empty = await Promise.race([
        (async () => {
          for (let count = 0; count < 8; count++) {
            const { done, value } = await reader.read();
            if (done) return true;
            if (value.byteLength) return false;
          }
          return false;
        })(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } catch {
      empty = false;
    } finally {
      clearTimeout(timer);
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reader.cancel().catch(() => {}),
          new Promise<void>((resolve) => {
            cancellationTimer = setTimeout(resolve, 100);
          }),
        ]);
      } finally {
        clearTimeout(cancellationTimer);
      }
    }
    if (!empty) return respond(400);
  }
  const iat = Math.floor((options.now ?? Date.now()) / 1000),
    exp = iat + COOKIE_SECONDS;
  const payload = `v1.${iat}.${exp}.${randomBytes(16).toString("base64url")}`;
  const response = respond(204);
  response.headers.set(
    "Set-Cookie",
    `${PREVIEW_COOKIE}=${payload}.${signature(payload, origin, options.cookieSecret)}; Path=/; Max-Age=${COOKIE_SECONDS}; Secure; HttpOnly; SameSite=Strict`,
  );
  return response;
}

/** The preview credential must not reach framework routes or upstream services. */
export function withoutPreviewCredential(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  const remaining = (headers.get("Cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith(`${PREVIEW_COOKIE}=`));
  if (remaining.length) headers.set("Cookie", remaining.join("; "));
  else headers.delete("Cookie");
  return new Request(request, { headers });
}

/** Prevent authorized HTML/assets from becoming shared-cache responses. */
export function privatePreviewResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  const vary = headers.get("Vary");
  if (!vary?.split(",").some((value) => value.trim().toLowerCase() === "authorization"))
    headers.set("Vary", vary ? `${vary}, Authorization` : "Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
