/** Server-owned Coder origin. Never use request input to choose a credential target. */
function normalizeCoderOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (process.env.NODE_ENV === "production" && url.protocol !== "https:")
  ) {
    throw new Error("Invalid Coder origin");
  }
  return url.origin;
}

export function getConfiguredCoderUrl(): string {
  const value = process.env.CODER_URL?.trim();
  if (!value) throw new Error("CODER_URL is not configured");
  try {
    return normalizeCoderOrigin(value);
  } catch {
    // Configuration can contain userinfo. Do not include the supplied value in errors.
    throw new Error("CODER_URL must be an HTTP(S) origin (HTTPS in production)");
  }
}

export function isConfiguredCoderUrl(value: string): boolean {
  try {
    return normalizeCoderOrigin(value) === getConfiguredCoderUrl();
  } catch {
    return false;
  }
}
