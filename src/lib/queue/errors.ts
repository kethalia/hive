import { UserClientException, UserClientError } from "@/lib/coder/user-client";

export function isAuthError(error: unknown): boolean {
  if (
    error instanceof UserClientException &&
    (error.code === UserClientError.KEY_MISMATCH ||
      error.code === UserClientError.NO_TOKEN)
  ) {
    return true;
  }

  const msg =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\b(401|403)\b/.test(msg);
}

export function isNetworkError(error: unknown): boolean {
  const msg =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up/i.test(
    msg
  );
}
