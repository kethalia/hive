import { KNOWN_TEMPLATES } from "../../../src/lib/templates/catalog";

/** Transport capability only: the Next route still requires authenticated owner
 * authority and same-origin mutation checks. No preview-auth exception is added. */
export function isPortableTemplatePublication(request: Request, enabled?: string) {
  if (enabled !== "true" || request.headers.has("Next-Action") || request.headers.has("Upgrade"))
    return false;
  const url = new URL(request.url);
  if (url.search || request.url.includes("?")) return false;
  const match =
    /^\/api\/templates\/([a-z0-9-]+)\/push(?:\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/stream)?$/.exec(
      url.pathname,
    );
  if (!match || !(KNOWN_TEMPLATES as readonly string[]).includes(match[1])) return false;
  return match[2] ? request.method === "GET" : request.method === "POST";
}
