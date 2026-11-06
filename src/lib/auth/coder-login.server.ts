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
export function coderLoginError(
  search: Record<string, string | string[] | undefined>,
): "failed" | null {
  return search.error === "coder_oauth_failed" ? "failed" : null;
}
