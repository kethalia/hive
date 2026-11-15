export const CODER_OAUTH_POPUP_MESSAGE = "hive:coder-oauth-complete";

export function validCoderOAuthPopupAttempt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
