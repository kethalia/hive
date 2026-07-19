const scriptSource =
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";

export const CODER_HOST_COOKIE = "hive-coder-host";

export function coderFrameSources(configuredUrls: readonly string[]): string {
  const sources = new Set<string>();
  for (const configuredUrl of configuredUrls) {
    try {
      const url = new URL(configuredUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const suffixWildcard = url.hostname.match(/^\*--[^.]+(\..+)$/);
      if (suffixWildcard) {
        sources.add(`${url.protocol}//*${suffixWildcard[1]}${url.port ? `:${url.port}` : ""}`);
        continue;
      }
      sources.add(url.origin);
      sources.add(`${url.protocol}//*.${url.host}`);
    } catch {
      // Ignore malformed configuration and cookie values.
    }
  }
  return [...sources].join(" ");
}

export function buildContentSecurityPolicy(configuredUrls: readonly string[] = []): string {
  const frameSources = ["'self'", coderFrameSources(configuredUrls)].filter(Boolean).join(" ");
  return `default-src 'self'; base-uri 'self'; frame-ancestors 'self'; frame-src ${frameSources}; form-action 'self'; object-src 'none'; ${scriptSource}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' http: https: wss: ws:; worker-src 'self' blob:`;
}
