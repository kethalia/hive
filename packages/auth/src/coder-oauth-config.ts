export const CODER_OAUTH_CALLBACK_PATH = "/api/auth/coder/callback";
export const CODER_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
export const CODER_OAUTH_FLOW_COOKIE = "__Host-hive-coder-oauth";

export interface CoderOAuthConfig {
  coderOrigin: string;
  publicOrigin: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}
/** Server configuration only. Never serialize this object into page props. */
export function getCoderOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): CoderOAuthConfig | null {
  if (env.HIVE_CODER_OAUTH_ENABLED !== "true") return null;
  try {
    const origin = (raw: string | undefined) => {
      if (!raw) throw new Error();
      const value = new URL(raw);
      if (
        value.protocol !== "https:" ||
        value.username ||
        value.password ||
        value.pathname !== "/" ||
        value.search ||
        value.hash ||
        value.origin !== raw.replace(/\/$/, "")
      )
        throw new Error();
      return value.origin;
    };
    const coderOrigin = origin(env.CODER_URL),
      publicOrigin = origin(env.HIVE_PUBLIC_ORIGIN),
      clientId = env.HIVE_CODER_OAUTH_CLIENT_ID ?? "",
      clientSecret = env.HIVE_CODER_OAUTH_CLIENT_SECRET ?? "";
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(clientId) ||
      !clientSecret ||
      clientSecret.length > 4096 ||
      /[\r\n]/.test(clientSecret)
    )
      throw new Error();
    return {
      coderOrigin,
      publicOrigin,
      clientId,
      clientSecret,
      callbackUrl: publicOrigin + CODER_OAUTH_CALLBACK_PATH,
    };
  } catch {
    throw new Error("coder_oauth_unavailable");
  }
}
