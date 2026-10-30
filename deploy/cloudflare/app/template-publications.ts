import { KNOWN_TEMPLATES } from "../../../src/lib/templates/catalog";

/** Transport capability only: the Next route still requires authenticated owner
 * authority and same-origin mutation checks. No preview-auth exception is added. */
export function isPortableTemplatePublication(
  request: Request,
  enabled?: string,
  logViewEnabled?: string,
) {
  if (request.headers.has("Next-Action") || request.headers.has("Upgrade")) return false;
  const url = new URL(request.url);
  const logs =
    /^\/api\/templates\/([a-z0-9-]+)\/push\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/logs$/.exec(
      url.pathname,
    );
  if (logs) {
    if (
      logViewEnabled !== "true" ||
      request.method !== "GET" ||
      !(KNOWN_TEMPLATES as readonly string[]).includes(logs[1])
    )
      return false;
    if (!request.url.includes("?")) return true;
    const cursor = /^\?after=(0|[1-9][0-9]{0,18})$/.exec(url.search);
    return !!cursor && BigInt(cursor[1]) <= BigInt("9223372036854775807");
  }
  if (enabled !== "true") return false;
  if (url.search || request.url.includes("?")) return false;
  const match =
    /^\/api\/templates\/([a-z0-9-]+)\/push(?:\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/stream)?$/.exec(
      url.pathname,
    );
  if (!match || !(KNOWN_TEMPLATES as readonly string[]).includes(match[1])) return false;
  return match[2] ? request.method === "GET" : request.method === "POST";
}
