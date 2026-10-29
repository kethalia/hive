import { timingSafeEqual } from "node:crypto";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization",
};

/** Preview authority is runtime-only, independent of Hive sessions and Coder tokens. */
export function authorizePreview(request: Request, secret: unknown): Response | null {
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/i.test(secret))
    return Response.json(
      { error: "Private preview is not configured." },
      { status: 503, headers: privateHeaders },
    );
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("Authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return Response.json(
      { error: "Private preview authorization required." },
      { status: 401, headers: privateHeaders },
    );
  return null;
}

/** The preview credential must not reach framework routes or upstream services. */
export function withoutPreviewCredential(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
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
