export type CoderOAuthConfig = {
  coderOrigin: string;
  publicOrigin: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  secret: string;
};

export function coderOAuthEnabled() {
  return process.env.HIVE_CODER_OAUTH_ENABLED === "true";
}

function origin(value: string | undefined) {
  const url = new URL(value ?? "");
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw Error("coder_oauth_configuration");
  return url.origin;
}

export function getCoderOAuthConfig(): CoderOAuthConfig {
  const coderOrigin = origin(process.env.CODER_URL);
  const publicOrigin = origin(process.env.HIVE_PUBLIC_ORIGIN);
  const clientId = process.env.CODER_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.CODER_OAUTH_CLIENT_SECRET ?? "";
  const secret = process.env.COOKIE_SECRET ?? "";
  if (!clientId || clientId.length > 256 || !clientSecret || secret.length < 32)
    throw Error("coder_oauth_configuration");
  return {
    coderOrigin,
    publicOrigin,
    clientId,
    clientSecret,
    secret,
    callbackUrl: `${publicOrigin}/api/auth/callback/coder`,
  };
}

export { coderAuthCookieName, coderAuthCookieValues } from "@hive/auth";
