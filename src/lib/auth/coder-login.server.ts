import { getCoderOAuthConfig } from "@hive/auth";

export type CoderLoginMode = "legacy" | "oauth" | "oauth-unavailable";
/** This projection alone is safe for presentation. Never return the server's
 * OAuth config (which contains the confidential client secret) as page props. */
export function coderLoginMode(
  env: Record<string, string | undefined> = process.env,
): CoderLoginMode {
  try {
    return getCoderOAuthConfig(env) ? "oauth" : "legacy";
  } catch {
    return "oauth-unavailable";
  }
}
/** Public navigation only; never expose the confidential server config as props.
 * Deployment-specific preview hosts must start the flow on the enrolled origin. */
export function coderLoginStartUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  try {
    const config = getCoderOAuthConfig(env);
    return config ? `${config.publicOrigin}/api/auth/coder/start` : null;
  } catch {
    return null;
  }
}
export function coderLoginError(
  search: Record<string, string | string[] | undefined>,
): "failed" | null {
  return search.error === "coder_oauth_failed" ? "failed" : null;
}
